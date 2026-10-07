"""Cataloguing and search.

Search is dispatched on the database dialect (see :func:`shelfwise.db.search_backend`):

* SQLite — FTS5 with BM25 field weighting (title and ISBN weigh most), Porter stemming and
  diacritic folding.
* PostgreSQL — a weighted ``tsvector`` (title/ISBN A, authors B, subjects C, series/publisher/
  description D) behind a GIN index, ``websearch_to_tsquery``; matches are ranked with
  ``ts_rank`` and the best ``PG_RERANK_WINDOW`` re-ranked with ``ts_rank_cd`` (cover density).

Both match the last query term as a prefix. Filtering, counting, sorting and pagination all run
in SQL, so a search touches only one page of rows in Python no matter how large the catalogue
is. Subjects and authors are also kept in ``biblio_facets`` (maintained with the full-text index),
which turns subject/author filters into index lookups. Scalar facets (format, language, decade)
are exact; subject and author facets are computed over the best ``FACET_SAMPLE`` matches.
Records must be written through this module (or followed by ``reindex_all``) to be searchable.
"""

from __future__ import annotations

import re
import threading
import time
from collections import Counter, OrderedDict
from dataclasses import dataclass, field

from sqlalchemy import Float, Integer, and_, delete, exists, func, insert, literal, or_, select, text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import search_backend
from ..errors import Conflict, NotFound
from ..models import Biblio, BiblioFacet, Item, ItemStatus, utcnow

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


def _facet_rows(biblio: Biblio) -> list[dict]:
    rows, seen = [], set()
    for kind, values in (("s", biblio.subjects), ("a", biblio.authors)):
        for v in values or []:
            v = str(v).strip()
            if v and (kind, v.lower()) not in seen:
                seen.add((kind, v.lower()))
                rows.append({"biblio_id": biblio.id, "kind": kind, "value": v, "value_norm": v.lower()})
    return rows


def index_biblio(db: Session, biblio: Biblio) -> None:
    db.execute(delete(BiblioFacet).where(BiblioFacet.biblio_id == biblio.id))
    if biblio.deleted_at is None and (rows := _facet_rows(biblio)):
        db.execute(insert(BiblioFacet), rows)
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
    """Rebuild the full-text index and facet table in bulk (INSERT … SELECT; seconds for 100k records)."""
    _reindex_facets(db)
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
    return int(db.scalar(select(func.count()).select_from(Biblio).where(Biblio.deleted_at.is_(None))) or 0)


def _reindex_facets(db: Session) -> int:
    clear_search_cache()  # cached totals/facets may predate the rebuild (other processes: ≤ TTL)
    db.execute(delete(BiblioFacet))
    backend = search_backend(db)
    if backend in ("fts5", "tsvector"):
        for kind, col in (("s", "subjects"), ("a", "authors")):
            if backend == "fts5":
                sql = (f"INSERT INTO biblio_facets (biblio_id, kind, value, value_norm) "
                       f"SELECT DISTINCT b.id, '{kind}', trim(je.value), py_lower(trim(je.value)) "
                       f"FROM biblios b, json_each(b.{col}) je "
                       f"WHERE b.deleted_at IS NULL AND je.type = 'text' AND trim(je.value) <> ''")
            else:
                sql = (f"INSERT INTO biblio_facets (biblio_id, kind, value, value_norm) "
                       f"SELECT DISTINCT b.id, '{kind}', trim(x), lower(trim(x)) FROM biblios b, "
                       f"json_array_elements_text(CASE WHEN json_typeof(b.{col}) = 'array' THEN b.{col} "
                       f"ELSE '[]'::json END) AS x WHERE b.deleted_at IS NULL AND trim(x) <> ''")
            db.execute(text(sql))
    else:
        for b in db.scalars(select(Biblio).where(Biblio.deleted_at.is_(None))):
            if rows := _facet_rows(b):
                db.execute(insert(BiblioFacet), rows)
    return int(db.scalar(select(func.count()).select_from(BiblioFacet)) or 0)


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
    _catalogue_changed()
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
    biblio.updated_at = now  # bumps the catalogue signature that keys cached totals/facets
    for item in biblio.items:
        item.deleted_at = item.deleted_at or now
    index_biblio(db, biblio)
    _catalogue_changed()


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
PG_RERANK_WINDOW = 1000  # PostgreSQL: best matches re-ranked with ts_rank_cd


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
    """``(ids, scored, order)`` for a text query: an id-only subquery of matches (cheap: for
    counting, filtering and facets), a scored subquery and its best-first ORDER BY (for the page).
    None when ``q`` contains no searchable terms."""
    if not q or not q.strip():
        return None
    backend = search_backend(db)
    if backend == "fts5":
        m = fts_query(q)
        if not m:
            return None
        ids = (text("SELECT rowid AS id FROM biblio_fts WHERE biblio_fts MATCH :m").bindparams(m=m)
               .columns(id=Integer).subquery("fts_ids"))
        sub = (text(f"SELECT rowid AS id, bm25(biblio_fts, {FTS_WEIGHTS}) AS score FROM biblio_fts "
                    "WHERE biblio_fts MATCH :m").bindparams(m=m)
               .columns(id=Integer, score=Float).subquery("fts"))
        return ids, sub, [sub.c.score.asc(), sub.c.id.asc()]
    if backend == "tsvector":
        tsq = pg_tsquery(q)
        if not tsq:
            return None
        expr, binds = tsq
        ids = (text(f"SELECT s.biblio_id AS id FROM biblio_search s, (SELECT {expr} AS query) AS tq "
                    "WHERE s.document @@ tq.query").bindparams(**binds).columns(id=Integer).subquery("tsv_ids"))
        # Two-stage ranking: cheap ts_rank over every match, then ts_rank_cd (cover density, ~10x
        # dearer with prefix terms) for the best PG_RERANK_WINDOW, which always sort first.
        sub = (text(
            "SELECT id, CASE WHEN rn <= :rerank THEN 1000.0 + ts_rank_cd(document, query) ELSE r END AS score, "
            "title_len FROM (SELECT m.*, row_number() OVER (ORDER BY r DESC, id) AS rn FROM "
            "(SELECT s.biblio_id AS id, s.document, s.title_len, tq.query, ts_rank(s.document, tq.query) AS r "
            f"FROM biblio_search s, (SELECT {expr} AS query) AS tq WHERE s.document @@ tq.query) AS m) AS ranked")
               .bindparams(rerank=PG_RERANK_WINDOW, **binds)
               .columns(id=Integer, score=Float, title_len=Integer).subquery("tsv"))
        return ids, sub, [sub.c.score.desc(), sub.c.title_len.asc(), sub.c.id.asc()]
    # Portable fallback for other databases
    like = f"%{q.strip()}%"
    sub = (select(Biblio.id.label("id"), literal(0.0).label("score"))
           .where(Biblio.deleted_at.is_(None),
                  or_(Biblio.title.ilike(like), Biblio.description.ilike(like), Biblio.isbn == q.strip()))
           .subquery("lk"))
    return sub, sub, [sub.c.id.asc()]


def _candidate_ids(db: Session, q: str | None, limit: int = CANDIDATE_LIMIT) -> list[int] | None:
    """Ranked ids for a text query, or None when there is no text query."""
    m = _match(db, q)
    if m is None:
        return None
    _ids, sub, order = m
    return list(db.scalars(select(sub.c.id).order_by(*order).limit(limit)))


def _facet_values(db: Session, kind: str, values: list[str], *, like: bool = False):
    """Ids of records having a subject/author (``kind`` s/a) equal to — or containing — a value."""
    norm = BiblioFacet.value_norm
    cond = norm.contains(values[0].lower(), autoescape=True) if like else norm == values[0].lower()
    return select(BiblioFacet.biblio_id).where(BiblioFacet.kind == kind, cond)


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
        # A subject also matches its subdivided forms ("Whaling" ⊃ "Whaling -- Fiction").
        s = filters.subject.lower()
        stmt = stmt.where(Biblio.id.in_(select(BiblioFacet.biblio_id).where(
            BiblioFacet.kind == "s",
            or_(BiblioFacet.value_norm == s, BiblioFacet.value_norm.startswith(s + " -- ", autoescape=True)))))
    if filters.author:
        stmt = stmt.where(Biblio.id.in_(_facet_values(db, "a", [filters.author], like=True)))
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


def _catalogue_changed() -> None:
    """Invalidate per-process caches after a write. Coarse clocks (notably on Windows) can give an
    edit the same ``updated_at`` as an earlier one, so the timestamp signature alone is not enough."""
    clear_search_cache()
    from ..ai import semantic  # lazy: avoids an import cycle

    semantic.index.invalidate()


# ------------------------------------------------------------------ facet/total cache
# Totals and facets of searches that do not depend on item status are cached per process,
# keyed by a catalogue signature (max id, max updated_at — two index lookups), so repeated
# browsing of a large catalogue only pays for the page query. Any record change invalidates.

_CACHE_TTL = 60.0
_CACHE_MAX = 256
_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


def _catalogue_signature(db: Session) -> tuple:
    return (db.scalar(select(func.max(Biblio.id))), db.scalar(select(func.max(Biblio.updated_at))))


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None or time.monotonic() - hit[0] > _CACHE_TTL:
            return None
        _cache.move_to_end(key)
        return hit[1]


def _cache_put(key, value) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic(), value)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def clear_search_cache() -> None:
    with _cache_lock:
        _cache.clear()


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
    """Ranked, filtered, faceted search. Per request: one grouped query (total + scalar facets),
    one ordered id query (page + facet sample) and two facet GROUP BYs on ``biblio_facets``."""
    started = time.perf_counter()
    filters = filters or SearchFilters()
    m = _match(db, q)
    base = select(Biblio.id).where(Biblio.deleted_at.is_(None))
    stmt, ranked, match_order = base, base, None
    if m is not None:
        ids_sub, scored, match_order = m
        stmt = base.where(Biblio.id.in_(select(ids_sub.c.id)))  # unscored: counting/facets
        ranked = base.join(scored, scored.c.id == Biblio.id)  # scored: ordering
    stmt = _apply_filters(db, stmt, filters)
    ranked = _apply_filters(db, ranked, filters)
    order = _order(sort, match_order)
    if match_order is None or sort != "relevance":
        ranked = stmt  # ordering does not need the score

    cache_key = None
    if not (filters.available_only or filters.branch_id):
        cache_key = (db.get_bind().url.render_as_string(hide_password=True), (q or "").strip().lower(),
                     tuple(sorted(vars(filters).items())), sort, facets, _catalogue_signature(db))
    cached = _cache_get(cache_key) if cache_key else None

    start = max(page - 1, 0) * per_page
    if cached is not None:
        total, facet_data = cached
        ids = list(db.scalars(ranked.order_by(*order).offset(start).limit(per_page))) if total else []
    else:
        total, facet_data, ids = _run(db, stmt, ranked, order, start, per_page, facets)
        if cache_key:
            _cache_put(cache_key, (total, facet_data))
    took = (time.perf_counter() - started) * 1000
    _observe_search("keyword" if m is not None else "browse", took / 1000)
    return SearchResult(total=total, ids=ids, facets=facet_data, took_ms=round(took, 2))


def _run(db: Session, stmt, ranked, order, start: int, per_page: int, facets: bool):
    if not facets:
        total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
        ids = list(db.scalars(ranked.order_by(*order).offset(start).limit(per_page))) if total else []
        return total, {}, ids
    # Total and the scalar facets in one pass over the matching rows.
    decade = (Biblio.pub_year // 10) * 10
    grouped = db.execute(stmt.with_only_columns(Biblio.material_type, Biblio.language, decade, func.count())
                         .group_by(Biblio.material_type, Biblio.language, decade)).all()
    total = sum(int(r[3]) for r in grouped)
    if not total:
        return 0, {}, []
    types, langs, decades = Counter(), Counter(), Counter()
    for mt, lang, dec, n in grouped:
        if mt is not None:
            types[mt] += n
        if lang is not None:
            langs[lang] += n
        if dec is not None:
            decades[int(dec)] += n
    # Best matches in the requested order: the page (when shallow) and the facet sample.
    head = list(db.scalars(ranked.order_by(*order).limit(FACET_SAMPLE)))
    if start + per_page <= len(head) or len(head) >= total:
        ids = head[start:start + per_page]
    else:
        ids = list(db.scalars(ranked.order_by(*order).offset(start).limit(per_page)))
    facet_data = {
        "material_type": _top(types, 8),
        "language": _top(langs, 8),
        "subject": _array_facet(db, "s", head, 15),
        "author": _array_facet(db, "a", head, 10),
        "decade": [(f"{d}s", int(n)) for d, n in sorted(decades.items(), reverse=True)[:10]],
    }
    return total, facet_data, ids


def _top(counter: Counter, n: int) -> list[tuple[str, int]]:
    return [(k, int(v)) for k, v in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))[:n]]


def _array_facet(db: Session, kind: str, ids: list[int], limit: int) -> list[tuple[str, int]]:
    if not ids:
        return []
    n = func.count().label("n")
    counts: Counter = Counter()
    for i in range(0, len(ids), 5000):
        rows = db.execute(select(BiblioFacet.value, n).where(BiblioFacet.kind == kind,
                                                             BiblioFacet.biblio_id.in_(ids[i:i + 5000]))
                          .group_by(BiblioFacet.value)).all()
        for value, c in rows:
            counts[value] += int(c)
    return _top(counts, limit)


def filter_ids(db: Session, filters: SearchFilters | None, ids) -> set[int]:
    """The subset of ``ids`` that are live records matching ``filters`` (bounded queries)."""
    ids = list(dict.fromkeys(ids))
    if not ids:
        return set()
    out: set[int] = set()
    for i in range(0, len(ids), 5000):
        stmt = select(Biblio.id).where(Biblio.deleted_at.is_(None), Biblio.id.in_(ids[i:i + 5000]))
        out.update(db.scalars(_apply_filters(db, stmt, filters or SearchFilters())))
    return out


def ensure_search_index(db: Session) -> int:
    """Rebuild the search tables if records exist but the index is empty (fresh PostgreSQL after
    a data migration, or a database created before ``biblio_facets`` existed). Returns the number
    of records indexed (0 when nothing was needed)."""
    if db.scalar(select(Biblio.id).where(Biblio.deleted_at.is_(None)).limit(1)) is None:
        return 0
    backend = search_backend(db)
    table = {"fts5": "biblio_fts", "tsvector": "biblio_search"}.get(backend)
    fts_empty = table is not None and db.execute(text(f"SELECT 1 FROM {table} LIMIT 1")).first() is None
    facets_empty = db.scalar(select(BiblioFacet.id).limit(1)) is None
    if fts_empty:
        return reindex_all(db)
    if facets_empty:
        return _reindex_facets(db)
    return 0


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
