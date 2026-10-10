"""Cataloguing helpers behind the staff record page: duplicate detection and a record's change history.

* :func:`find_duplicates` — candidate duplicates for a record (or for a record being keyed in), with the
  reasons a cataloguer needs to decide quickly: same ISBN, same title (normalised: case, punctuation and
  leading articles ignored) and author overlap. Used by the record page's "Similar & duplicates" tab and by
  the live duplicate check in the record editor.
* :func:`history` — the audit trail of a record and its items (creation, edits, MARC edits, cover changes,
  item adds/edits/deletes, check-ins, batch changes), newest first, without client IP addresses.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..models import AuditLog, Biblio, Item
from . import catalog

_ARTICLES = ("the ", "a ", "an ", "le ", "la ", "les ", "der ", "die ", "das ", "el ", "los ")
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACE = re.compile(r"\s+")
TITLE_THRESHOLD = 0.88


def title_key(title: str | None) -> str:
    """Comparable form of a title: accents folded, lower case, no punctuation or leading article."""
    s = unicodedata.normalize("NFKD", title or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = _SPACE.sub(" ", _PUNCT.sub(" ", s)).strip()
    for art in _ARTICLES:
        if s.startswith(art):
            s = s[len(art):]
            break
    return s


def _surnames(authors: list[str] | None) -> set[str]:
    out = set()
    for a in authors or []:
        a = (a or "").strip()
        if not a:
            continue
        name = a.split(",")[0] if "," in a else a.split()[-1]
        key = title_key(name)
        if key:
            out.add(key)
    return out


def find_duplicates(db: Session, *, title: str | None = None, isbn: str | None = None,
                    authors: list[str] | None = None, exclude_id: int | None = None, limit: int = 8) -> list[dict]:
    """Records that may duplicate the given description, best match first."""
    candidates: dict[int, dict] = {}

    def add(b: Biblio, reason: str, score: float) -> None:
        if b.id == exclude_id or b.deleted_at is not None:
            return
        row = candidates.setdefault(b.id, {"biblio": b, "reasons": [], "score": 0.0})
        if reason not in row["reasons"]:
            row["reasons"].append(reason)
        row["score"] = max(row["score"], score)

    norm = catalog.normalize_isbn(isbn) if isbn else None
    if norm:
        for b in db.scalars(select(Biblio).where(Biblio.isbn == norm, Biblio.deleted_at.is_(None)).limit(20)):
            add(b, "isbn", 1.0)

    key = title_key(title)
    if len(key) >= 3:
        wanted = _surnames(authors)
        ids = catalog.search(db, title, page=1, per_page=25, facets=False).ids
        for b in catalog.load_biblios(db, ids):
            ratio = SequenceMatcher(None, key, title_key(b.title)).ratio()
            if ratio < TITLE_THRESHOLD:
                continue
            add(b, "title", ratio * 0.9)
            if wanted and wanted & _surnames(b.authors):
                add(b, "author", min(1.0, ratio * 0.9 + 0.08))

    rows = sorted(candidates.values(), key=lambda r: (-r["score"], r["biblio"].id))[:limit]
    avail = catalog.availability(db, [r["biblio"].id for r in rows])
    out = []
    for r in rows:
        b = r["biblio"]
        out.append({"id": b.id, "title": b.title, "subtitle": b.subtitle, "authors": b.authors or [], "isbn": b.isbn,
                    "publisher": b.publisher, "pub_year": b.pub_year, "edition": b.edition,
                    "material_type": b.material_type, "cover": None, "reasons": r["reasons"],
                    "score": round(r["score"] * 100), "availability": avail.get(b.id)})
    return out


_ITEM_ACTIONS_WITH_IDS = ("batch_modify", "batch_withdraw", "batch_delete")


def history(db: Session, biblio_id: int, *, limit: int = 100) -> list[dict]:
    """Audit entries for a record and its items, newest first (IP addresses are never included)."""
    items = {i.id: i.barcode for i in db.scalars(select(Item).where(Item.biblio_id == biblio_id))}
    cond = and_(AuditLog.entity == "biblio", AuditLog.entity_id == biblio_id)
    if items:
        cond = or_(cond, and_(AuditLog.entity == "item", AuditLog.entity_id.in_(list(items))))
    rows = list(db.scalars(select(AuditLog).where(cond).order_by(AuditLog.id.desc()).limit(limit)))
    touched_by: dict[int, list[int]] = {}
    if items:
        # Batch tools log one entry for many items (entity_id is empty); keep those touching this record.
        batch = db.scalars(select(AuditLog).where(AuditLog.entity == "item", AuditLog.entity_id.is_(None),
                                                  AuditLog.action.in_(_ITEM_ACTIONS_WITH_IDS))
                           .order_by(AuditLog.id.desc()).limit(500))
        for a in batch:
            ids = [i for i in (a.details or {}).get("item_ids") or [] if i in items]
            if ids:
                touched_by[a.id] = ids
                rows.append(a)
        rows.sort(key=lambda a: a.id, reverse=True)
        rows = rows[:limit]
    out = []
    for a in rows:
        details = {k: v for k, v in (a.details or {}).items() if k not in ("item_ids", "ip")}
        touched = touched_by.get(a.id)
        entry = {"id": a.id, "at": a.at, "action": a.action, "entity": a.entity, "entity_id": a.entity_id,
                 "actor": a.actor.full_name if a.actor else None, "details": details}
        if a.entity == "item":
            if a.entity_id in items:
                entry["barcode"] = items[a.entity_id]
            if touched:
                entry["barcodes"] = [items[i] for i in touched][:20]
                entry["count"] = len(touched)
        out.append(entry)
    return out
