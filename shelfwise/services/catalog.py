"""Cataloguing and search.

Search is dispatched on the database dialect (see :func:`shelfwise.db.search_backend`):

* SQLite — FTS5 with BM25 field weighting (title and ISBN weigh most), Porter stemming and
  diacritic folding.
* PostgreSQL — a weighted ``tsvector`` (title/ISBN A, authors B, subjects C, series/publisher/
  description D) behind a GIN index, ``websearch_to_tsquery`` and ``ts_rank_cd`` ordering.

Both match the last query term as a prefix. Filtering, counting, sorting and pagination all run
in SQL, so a search touches only one page of rows in Python no matter how large the catalogue
is. Scalar facets (format, language, decade) are exact; subject and author facets are computed
over the best ``FACET_SAMPLE`` matches to bound their cost.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from sqlalchemy import Float, Integer, and_, case, exists, func, literal, or_, select, text, true
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import search_backend
from ..errors import Conflict, NotFound
from ..models import Biblio, Item, ItemStatus, utcnow

# ------------------------------------------------------------------ ISBN helpers


def normalize_isbn(raw: str | None) -> str | None:
    """Return a canonical ISBN-13 (digits only) or None if the value is not a valid ISBN."""
    if not raw:
        return None
    s = re.sub(r"[^0-9Xx]", "", raw.split(" ")[0]).upper()
    if len(s) == 10 and _isbn10_ok(s):
        core = "978" + s[:9]
        return core + _isbn13_check(core)
    if len(s) == 13 and s.isdigit() and _isbn13_check(s[:12]) == s[12]:
        return s
    return None


def _isbn10_ok(s: str) -> bool:
    if not (s[:9].isdigit() and (s[9].isdigit() or s[9] == "X")):
        return False
    total = sum((10 - i) * int(c) for i, c in enumerate(s[:9]))
    total += 10 if s[9] == "X" else int(s[9])
    return total % 11 == 0


def _isbn13_check(first12: str) -> str:
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(first12))
    return str((10 - total % 10) % 10)


# ------------------------------------------------------------------ indexing

BIBLIO_FIELDS = (
    "title",
    "subtitle",
    "authors",
    "isbn",
    "issn",
    "publisher",
    "pub_year",
    "edition",
    "language",
    "material_type",
    "subjects",
    "series",
    "pages",
    "description",
    "classification",
    "audience",
    "cover_url",
    "ai_enriched",
)

_PG_DOCUMENT = (
    "setweight(to_tsvector(CAST(:cfg AS regconfig), {title}), 'A') || "
    "setweight(to_tsvector('simple', {isbn}), 'A') || "
    "setweight(to_tsvector(CAST(:cfg AS regconfig), {authors}), 'B') || "
    "setweight(to_tsvector(CAST(:cfg AS regconfig), {subjects}), 'C') || "
    "setweight(to_tsvector(CAST(:cfg AS regconfig), {rest}), 'D')"
)


def _pg_json_text(col: str) -> str:
    return (f"coalesce((SELECT string_agg(x, ' ') FROM json_array_elements_text("
            f"CASE WHEN json_typeof({col}) = 'array' THEN {col} ELSE '[]'::json END) AS x), '')")


def _index_fields(biblio: Biblio) -> dict:
    title = " ".join(filter(None, [biblio.title, biblio.subtitle]))
    return {
        "id": biblio.id,
        "title": title,
        "authors": " ".join(biblio.authors or []),
        "subjects": " ".join(biblio.subjects or []),
        "description": biblio.description or "",
        "publisher": biblio.publisher or "",
        "isbn": biblio.isbn or "",
        "series": biblio.series or "",
        "title_len": min(len(_TOKEN.findall(biblio.title or "")), 32000),
    }


def index_biblio(db: Session, biblio: Biblio) -> None:
    backend = search_backend(db)
    if backend == "fts5":
        db.execute(text("DELETE FROM biblio_fts WHERE rowid = :id"), {"id": biblio.id})
        if biblio.deleted_at is not None:
            return
        fields = _index_fields(biblio)
        fields.pop("title_len")
        db.execute(
            text(
                "INSERT INTO biblio_fts(rowid, title, authors, subjects, description, publisher, isbn,"
                " series) VALUES (:id, :title, :authors, :subjects, :description, :publisher, :isbn,"
                " :series)"
            ),
            fields,
        )
    elif backend == "tsvector":
        if biblio.deleted_at is not None:
            db.execute(text("DELETE FROM biblio_search WHERE biblio_id = :id"), {"id": biblio.id})
            return
        fields = _index_fields(biblio)
        fields["rest"] = " ".join(filter(None, [fields.pop("series"), fields.pop("publisher"),
                                                fields.pop("description")]))
        fields["cfg"] = get_settings().pg_search_config
        doc = _PG_DOCUMENT.format(title=":title", isbn=":isbn", authors=":authors", subjects=":subjects", rest=":rest")
        db.execute(
            text(
                f"INSERT INTO biblio_search (biblio_id, document, title_len) VALUES (:id, {doc}, :title_len) "
                "ON CONFLICT (biblio_id) DO UPDATE SET document = EXCLUDED.document, title_len = EXCLUDED.title_len"
            ),
            fields,
        )


def reindex_all(db: Session) -> int:
    """Rebuild the full-text index in bulk (one INSERT … SELECT; seconds for 100k records)."""
    backend = search_backend(db)
    if backend == "fts5":
        db.execute(text("DELETE FROM biblio_fts"))
        db.execute(text(
            "INSERT INTO biblio_fts(rowid, title, authors, subjects, description, publisher, isbn, series) "
            "SELECT b.id, trim(coalesce(b.title, '') || ' ' || coalesce(b.subtitle, '')), "
            "coalesce((SELECT group_concat(value, ' ') FROM json_each(b.authors)), ''), "
            "coalesce((SELECT group_concat(value, ' ') FROM json_each(b.subjects)), ''), "
            "coalesce(b.description, ''), coalesce(b.publisher, ''), coalesce(b.isbn, ''), coalesce(b.series, '') "
            "FROM biblios b WHERE b.deleted_at IS NULL"
        ))
    elif backend == "tsvector":
        db.execute(text("DELETE FROM biblio_search"))
        doc = _PG_DOCUMENT.format(
            title="trim(coalesce(b.title, '') || ' ' || coalesce(b.subtitle, ''))",
            isbn="coalesce(b.isbn, '')",
            authors=_pg_json_text("b.authors"),
            subjects=_pg_json_text("b.subjects"),
            rest="coalesce(b.series, '') || ' ' || coalesce(b.publisher, '') || ' ' || coalesce(b.description, '')",
        )
        db.execute(text(
            f"INSERT INTO biblio_search (biblio_id, document, title_len) SELECT b.id, {doc}, "
            "LEAST(coalesce(array_length(regexp_split_to_array(trim(b.title), '[^[:alnum:]_]+'), 1), 0), 32000) "
            "FROM biblios b WHERE b.deleted_at IS NULL"
        ), {"cfg": get_settings().pg_search_config})
    else:
        return 0
    return int(db.scalar(select(func.count()).select_from(Biblio).where(Biblio.deleted_at.is_(None))) or 0)


# ------------------------------------------------------------------ CRUD


def _clean(data: dict) -> dict:
    out = {k: v for k, v in data.items() if k in BIBLIO_FIELDS}
    if "isbn" in out and out["isbn"]:
        out["isbn"] = normalize_isbn(out["isbn"]) or out["isbn"].strip()
    for key in ("authors", "subjects"):
        if key in out and out[key] is not None:
            seen: list[str] = []
            for v in out[key]:
                v = str(v).strip()
                if v and v.lower() not in {s.lower() for s in seen}:
                    seen.append(v)
            out[key] = seen
    if out.get("title"):
        out["title"] = out["title"].strip()
    return out


def create_biblio(db: Session, data: dict) -> Biblio:
    biblio = Biblio(**_clean(data))
    db.add(biblio)
    db.flush()
    index_biblio(db, biblio)
    return biblio


def update_biblio(db: Session, biblio: Biblio, data: dict) -> Biblio:
    for k, v in _clean(data).items():
        setattr(biblio, k, v)
    biblio.updated_at = utcnow()
    db.flush()
    index_biblio(db, biblio)
    return biblio


def get_biblio(db: Session, biblio_id: int) -> Biblio:
    b = db.get(Biblio, biblio_id)
    if b is None or b.deleted_at is not None:
        raise NotFound(f"Record {biblio_id} not found")
    return b


def delete_biblio(db: Session, biblio: Biblio) -> None:
    active = [i for i in biblio.items if i.deleted_at is None and i.status == ItemStatus.on_loan]
    if active:
        raise Conflict("Cannot delete a record while copies are on loan")
    now = utcnow()
    biblio.deleted_at = now
    for item in biblio.items:
        item.deleted_at = item.deleted_at or now
    index_biblio(db, biblio)


def create_item(db: Session, biblio: Biblio, data: dict) -> Item:
    barcode = str(data.get("barcode") or "").strip()
    if not barcode:
        barcode = next_barcode(db)
    if db.scalar(select(Item.id).where(Item.barcode == barcode)):
        raise Conflict(f"Barcode {barcode} already exists")
    item = Item(
        biblio_id=biblio.id,
        barcode=barcode,
        branch_id=data["branch_id"],
        item_type_id=data["item_type_id"],
        call_number=data.get("call_number") or biblio.classification,
        shelf_location=data.get("shelf_location"),
        price=data.get("price"),
        acquired_on=data.get("acquired_on"),
        notes=data.get("notes"),
        status=ItemStatus(data.get("status", ItemStatus.available)),
    )
    db.add(item)
    db.flush()
    return item


def next_barcode(db: Session) -> str:
    max_id = db.scalar(select(func.max(Item.id))) or 0
    candidate = max_id + 1
    while db.scalar(select(Item.id).where(Item.barcode == f"SW{candidate:08d}")):
        candidate += 1
    return f"SW{candidate:08d}"


def item_by_barcode(db: Session, barcode: str) -> Item:
    item = db.scalar(
        select(Item).where(Item.barcode == barcode.strip(), Item.deleted_at.is_(None))
    )
    if item is None:
        raise NotFound(f"No item with barcode {barcode!r}")
    return item


# ------------------------------------------------------------------ search

_TOKEN = re.compile(r"[\w]+", re.UNICODE)
_OPERATORS = {"and", "or", "not", "near"}

FTS_WEIGHTS = "10.0, 6.0, 4.0, 1.0, 1.5, 10.0, 2.0"  # title authors subjects desc publisher isbn series
FACET_SAMPLE = 2000  # subject/author facets are computed over the best N matches
CANDIDATE_LIMIT = 5000


def fts_query(q: str) -> str | None:
    """Turn free text into a safe FTS5 MATCH expression (each term quoted; last term prefixed)."""
    tokens = [t for t in _TOKEN.findall(q.lower()) if t not in _OPERATORS]
    if not tokens:
        return None
    parts = [f'"{t}"' for t in tokens[:-1]]
    last = tokens[-1]
    parts.append(f'"{last}"*' if len(last) >= 2 else f'"{last}"')
    return " ".join(parts)


def pg_tsquery(q: str) -> tuple[str, dict] | None:
    """SQL fragment + binds for a PostgreSQL tsquery. Plain queries AND all terms and match the
    last one as a prefix; queries using web-search syntax (quotes, ``-term``, ``OR``) go through
    ``websearch_to_tsquery`` unchanged. Every user value is a bound parameter."""
    cfg = get_settings().pg_search_config
    if '"' in q or re.search(r"(^|\s)-\w", q) or re.search(r"\sOR\s", q):
        if not _TOKEN.search(q):
            return None
        return "websearch_to_tsquery(CAST(:cfg AS regconfig), :tsq)", {"cfg": cfg, "tsq": q}
    tokens = [t for t in _TOKEN.findall(q.lower()) if t not in _OPERATORS]
    if not tokens:
        return None
    head, last = tokens[:-1], tokens[-1]
    binds = {"cfg": cfg, "tsq_last": last + (":*" if len(last) >= 2 else "")}
    expr = "to_tsquery(CAST(:cfg AS regconfig), :tsq_last)"
    if head:
        binds["tsq_head"] = " ".join(head)
        expr = f"(websearch_to_tsquery(CAST(:cfg AS regconfig), :tsq_head) && {expr})"
    return expr, binds


@dataclass
class SearchFilters:
    material_type: str | None = None
    language: str | None = None
    subject: str | None = None
    author: str | None = None
    audience: str | None = None
    year_from: int | None = None
    year_to: int | None = None
    branch_id: int | None = None
    available_only: bool = False


@dataclass
class SearchResult:
    total: int
    ids: list[int]
    facets: dict[str, list[tuple[str, int]]] = field(default_factory=dict)
    took_ms: float = 0.0


def _match(db: Session, q: str | None):
    """A subquery (id, score[, title_len]) of text matches, plus its best-first ORDER BY, or None
    when ``q`` contains no searchable terms."""
    if not q or not q.strip():
        return None
    backend = search_backend(db)
    if backend == "fts5":
        m = fts_query(q)
        if not m:
            return None
        sub = (text(f"SELECT rowid AS id, bm25(biblio_fts, {FTS_WEIGHTS}) AS score FROM biblio_fts "
                    "WHERE biblio_fts MATCH :m").bindparams(m=m)
               .columns(id=Integer, score=Float).subquery("fts"))
        return sub, [sub.c.score.asc(), sub.c.id.asc()]
    if backend == "tsvector":
        tsq = pg_tsquery(q)
        if not tsq:
            return None
        expr, binds = tsq
        sub = (text(f"SELECT s.biblio_id AS id, ts_rank_cd(s.document, tq.query) AS score, s.title_len "
                    f"FROM biblio_search s, (SELECT {expr} AS query) AS tq WHERE s.document @@ tq.query")
               .bindparams(**binds).columns(id=Integer, score=Float, title_len=Integer).subquery("tsv"))
        return sub, [sub.c.score.desc(), sub.c.title_len.asc(), sub.c.id.asc()]
    # Portable fallback for other databases
    like = f"%{q.strip()}%"
    sub = (select(Biblio.id.label("id"), literal(0.0).label("score"))
           .where(Biblio.deleted_at.is_(None),
                  or_(Biblio.title.ilike(like), Biblio.description.ilike(like), Biblio.isbn == q.strip()))
           .subquery("lk"))
    return sub, [sub.c.id.asc()]


def _candidate_ids(db: Session, q: str | None, limit: int = CANDIDATE_LIMIT) -> list[int] | None:
    """Ranked ids for a text query, or None when there is no text query."""
    m = _match(db, q)
    if m is None:
        return None
    sub, order = m
    return list(db.scalars(select(sub.c.id).order_by(*order).limit(limit)))


def _lower(db: Session, expr):
    # SQLite's lower() only folds ASCII; a Python UDF (registered on connect) handles Unicode.
    return func.py_lower(expr) if search_backend(db) == "fts5" else func.lower(expr)


def _json_values(db: Session, column):
    """Table-valued expansion of a JSON array column (column ``value``)."""
    if search_backend(db) == "tsvector":
        safe = case((func.json_typeof(column) == "array", column), else_=text("'[]'::json"))
        return func.json_array_elements_text(safe).table_valued("value")
    return func.json_each(column).table_valued("value")


def _apply_filters(db: Session, stmt, filters: SearchFilters):
    if filters.material_type:
        stmt = stmt.where(Biblio.material_type == filters.material_type)
    if filters.language:
        stmt = stmt.where(Biblio.language == filters.language)
    if filters.audience:
        stmt = stmt.where(Biblio.audience == filters.audience)
    if filters.year_from:
        stmt = stmt.where(Biblio.pub_year >= filters.year_from)
    if filters.year_to:
        stmt = stmt.where(Biblio.pub_year <= filters.year_to)
    if filters.subject:
        vals = _json_values(db, Biblio.subjects)
        stmt = stmt.where(exists(select(1).select_from(vals).where(_lower(db, vals.c.value) == filters.subject.lower())))
    if filters.author:
        vals = _json_values(db, Biblio.authors)
        stmt = stmt.where(exists(select(1).select_from(vals).where(
            _lower(db, vals.c.value).contains(filters.author.lower(), autoescape=True))))
    if filters.available_only or filters.branch_id:
        conds = [Item.biblio_id == Biblio.id, Item.deleted_at.is_(None)]
        if filters.available_only:
            conds.append(Item.status == ItemStatus.available)
        if filters.branch_id:
            conds.append(Item.branch_id == filters.branch_id)
        stmt = stmt.where(exists(select(1).where(and_(*conds))))
    return stmt


def _order(sort: str, match_order: list | None) -> list:
    if sort == "relevance" and match_order is not None:
        return match_order
    if sort == "title":
        return [func.lower(Biblio.title).asc(), Biblio.id.asc()]
    if sort == "year_desc":
        return [func.coalesce(Biblio.pub_year, 0).desc(), Biblio.id.asc()]
    if sort == "year_asc":
        return [func.coalesce(Biblio.pub_year, 9999).asc(), Biblio.id.asc()]
    return [Biblio.created_at.desc(), Biblio.id.desc()]  # newest additions


def search(
    db: Session,
    q: str | None,
    filters: SearchFilters | None = None,
    *,
    page: int = 1,
    per_page: int = 20,
    sort: str = "relevance",
    facets: bool = True,
) -> SearchResult:
    started = time.perf_counter()
    filters = filters or SearchFilters()
    m = _match(db, q)
    stmt = select(Biblio.id).where(Biblio.deleted_at.is_(None))
    match_order = None
    if m is not None:
        sub, match_order = m
        stmt = stmt.join(sub, sub.c.id == Biblio.id)
    stmt = _apply_filters(db, stmt, filters)
    order = _order(sort, match_order)

    total = int(db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0)
    ids: list[int] = []
    facet_data: dict[str, list[tuple[str, int]]] = {}
    if total:
        start = max(page - 1, 0) * per_page
        ids = list(db.scalars(stmt.order_by(*order).offset(start).limit(per_page)))
        if facets:
            facet_data = _facets(db, stmt, order, total)
    took = (time.perf_counter() - started) * 1000
    _observe_search("keyword" if m is not None else "browse", took / 1000)
    return SearchResult(total=total, ids=ids, facets=facet_data, took_ms=round(took, 2))


def filter_ids(db: Session, filters: SearchFilters | None, ids) -> set[int]:
    """The subset of ``ids`` that are live records matching ``filters`` (one bounded query)."""
    ids = list(dict.fromkeys(ids))
    if not ids:
        return set()
    out: set[int] = set()
    for i in range(0, len(ids), 5000):
        stmt = select(Biblio.id).where(Biblio.deleted_at.is_(None), Biblio.id.in_(ids[i:i + 5000]))
        out.update(db.scalars(_apply_filters(db, stmt, filters or SearchFilters())))
    return out


def _facets(db: Session, stmt, order: list, total: int) -> dict[str, list[tuple[str, int]]]:
    matched = stmt.order_by(None).subquery("matched")
    count = func.count().label("n")

    def scalar_facet(col, limit):
        rows = db.execute(select(col, count).join(matched, matched.c.id == Biblio.id)
                          .where(col.is_not(None)).group_by(col).order_by(count.desc(), col).limit(limit)).all()
        return [(v, int(n)) for v, n in rows]

    decade_col = (Biblio.pub_year // 10) * 10
    decades = db.execute(select(decade_col.label("d"), count).join(matched, matched.c.id == Biblio.id)
                         .where(Biblio.pub_year.is_not(None)).group_by(decade_col)
                         .order_by(decade_col.desc()).limit(10)).all()

    sample = matched if total <= FACET_SAMPLE else stmt.order_by(*order).limit(FACET_SAMPLE).subquery("sample")

    def array_facet(column, limit):
        vals = _json_values(db, column)
        rows = db.execute(select(vals.c.value, count).select_from(Biblio)
                          .join(sample, sample.c.id == Biblio.id).join(vals, true())
                          .where(vals.c.value.is_not(None))
                          .group_by(vals.c.value).order_by(count.desc(), vals.c.value).limit(limit)).all()
        return [(v, int(n)) for v, n in rows]

    return {
        "material_type": scalar_facet(Biblio.material_type, 8),
        "language": scalar_facet(Biblio.language, 8),
        "subject": array_facet(Biblio.subjects, 15),
        "author": array_facet(Biblio.authors, 10),
        "decade": [(f"{int(d)}s", int(n)) for d, n in decades],
    }


def _observe_search(kind: str, seconds: float) -> None:
    try:
        from ..observability import SEARCH_LATENCY

        SEARCH_LATENCY.labels(kind=kind).observe(seconds)
    except Exception:  # pragma: no cover - metrics must never break search
        pass


def availability(db: Session, biblio_ids: list[int]) -> dict[int, dict[str, int]]:
    """{biblio_id: {"total": n, "available": m}} in one grouped query."""
    if not biblio_ids:
        return {}
    rows = db.execute(
        select(Item.biblio_id, Item.status, func.count())
        .where(Item.biblio_id.in_(biblio_ids), Item.deleted_at.is_(None))
        .group_by(Item.biblio_id, Item.status)
    ).all()
    out: dict[int, dict[str, int]] = {bid: {"total": 0, "available": 0} for bid in biblio_ids}
    for bid, status, n in rows:
        if status == ItemStatus.withdrawn:
            continue
        out[bid]["total"] += n
        if status == ItemStatus.available:
            out[bid]["available"] += n
    return out


def load_biblios(db: Session, ids: list[int]) -> list[Biblio]:
    if not ids:
        return []
    by_id = {b.id: b for b in db.scalars(select(Biblio).where(Biblio.id.in_(ids)))}
    return [by_id[i] for i in ids if i in by_id]
