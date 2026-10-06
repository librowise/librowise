"""Cataloguing and search.

Search uses SQLite FTS5 with BM25 field weighting (title and ISBN weigh most), prefix matching
on the last term, diacritic folding and Porter stemming — no separate Zebra/Elasticsearch
daemon to operate. Facets are computed from the ranked candidate set.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from ..db import fts_available
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


def index_biblio(db: Session, biblio: Biblio) -> None:
    if not fts_available(db.get_bind()):
        return
    db.execute(text("DELETE FROM biblio_fts WHERE rowid = :id"), {"id": biblio.id})
    if biblio.deleted_at is not None:
        return
    db.execute(
        text(
            "INSERT INTO biblio_fts(rowid, title, authors, subjects, description, publisher, isbn,"
            " series) VALUES (:id, :title, :authors, :subjects, :description, :publisher, :isbn,"
            " :series)"
        ),
        {
            "id": biblio.id,
            "title": " ".join(filter(None, [biblio.title, biblio.subtitle])),
            "authors": " ".join(biblio.authors or []),
            "subjects": " ".join(biblio.subjects or []),
            "description": biblio.description or "",
            "publisher": biblio.publisher or "",
            "isbn": biblio.isbn or "",
            "series": biblio.series or "",
        },
    )


def reindex_all(db: Session) -> int:
    if not fts_available(db.get_bind()):
        return 0
    db.execute(text("DELETE FROM biblio_fts"))
    n = 0
    for b in db.scalars(select(Biblio).where(Biblio.deleted_at.is_(None))):
        index_biblio(db, b)
        n += 1
    return n


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

FTS_WEIGHTS = "10.0, 6.0, 4.0, 1.0, 1.5, 10.0, 2.0"  # title authors subjects desc publisher isbn series


def fts_query(q: str) -> str | None:
    """Turn free text into a safe FTS5 MATCH expression (each term quoted; last term prefixed)."""
    tokens = [t for t in _TOKEN.findall(q.lower()) if t not in {"and", "or", "not", "near"}]
    if not tokens:
        return None
    parts = [f'"{t}"' for t in tokens[:-1]]
    last = tokens[-1]
    parts.append(f'"{last}"*' if len(last) >= 2 else f'"{last}"')
    return " ".join(parts)


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


def _candidate_ids(db: Session, q: str | None, limit: int = 5000) -> list[int] | None:
    """Ranked ids for a text query, or None when there is no text query."""
    if not q or not q.strip():
        return None
    if fts_available(db.get_bind()):
        match = fts_query(q)
        if not match:
            return None
        rows = db.execute(
            text(
                f"SELECT rowid FROM biblio_fts WHERE biblio_fts MATCH :m "
                f"ORDER BY bm25(biblio_fts, {FTS_WEIGHTS}) LIMIT :lim"
            ),
            {"m": match, "lim": limit},
        ).all()
        return [r[0] for r in rows]
    # Portable fallback (e.g. PostgreSQL without a tsvector migration)
    like = f"%{q.strip()}%"
    stmt = (
        select(Biblio.id)
        .where(
            Biblio.deleted_at.is_(None),
            or_(Biblio.title.ilike(like), Biblio.description.ilike(like), Biblio.isbn == q.strip()),
        )
        .limit(limit)
    )
    return list(db.scalars(stmt))


def search(
    db: Session,
    q: str | None,
    filters: SearchFilters | None = None,
    *,
    page: int = 1,
    per_page: int = 20,
    sort: str = "relevance",
) -> SearchResult:
    started = datetime.now()
    filters = filters or SearchFilters()
    ranked = _candidate_ids(db, q)

    stmt = select(
        Biblio.id,
        Biblio.material_type,
        Biblio.language,
        Biblio.subjects,
        Biblio.authors,
        Biblio.pub_year,
        Biblio.title,
        Biblio.created_at,
    ).where(Biblio.deleted_at.is_(None))
    if ranked is not None:
        if not ranked:
            return SearchResult(total=0, ids=[], facets={}, took_ms=0.0)
        stmt = stmt.where(Biblio.id.in_(ranked))
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
    if filters.available_only or filters.branch_id:
        item_q = select(Item.biblio_id).where(Item.deleted_at.is_(None))
        if filters.available_only:
            item_q = item_q.where(Item.status == ItemStatus.available)
        if filters.branch_id:
            item_q = item_q.where(Item.branch_id == filters.branch_id)
        stmt = stmt.where(Biblio.id.in_(item_q))

    rows = db.execute(stmt).all()
    # JSON-array filters are applied in Python so the code stays portable across databases.
    if filters.subject:
        s = filters.subject.lower()
        rows = [r for r in rows if any(s == x.lower() for x in (r.subjects or []))]
    if filters.author:
        a = filters.author.lower()
        rows = [r for r in rows if any(a in x.lower() for x in (r.authors or []))]

    if sort == "relevance" and ranked is not None:
        order = {bid: i for i, bid in enumerate(ranked)}
        rows.sort(key=lambda r: order.get(r.id, 1 << 30))
    elif sort == "title":
        rows.sort(key=lambda r: (r.title or "").lower())
    elif sort == "year_desc":
        rows.sort(key=lambda r: r.pub_year or 0, reverse=True)
    elif sort == "year_asc":
        rows.sort(key=lambda r: r.pub_year or 9999)
    else:  # newest additions
        rows.sort(key=lambda r: r.created_at, reverse=True)

    facets = _facets(rows)
    start = max(page - 1, 0) * per_page
    ids = [r.id for r in rows[start : start + per_page]]
    took = (datetime.now() - started).total_seconds() * 1000
    return SearchResult(total=len(rows), ids=ids, facets=facets, took_ms=round(took, 2))


def _facets(rows) -> dict[str, list[tuple[str, int]]]:
    types, langs, subjects, authors, decades = Counter(), Counter(), Counter(), Counter(), Counter()
    for r in rows:
        types[r.material_type] += 1
        langs[r.language] += 1
        subjects.update(r.subjects or [])
        authors.update(r.authors or [])
        if r.pub_year:
            decades[f"{r.pub_year // 10 * 10}s"] += 1
    return {
        "material_type": types.most_common(8),
        "language": langs.most_common(8),
        "subject": subjects.most_common(15),
        "author": authors.most_common(10),
        "decade": sorted(decades.items(), reverse=True)[:10],
    }


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
