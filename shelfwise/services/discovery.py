"""OPAC discovery helpers: search-as-you-type suggestions, "did you mean" spelling correction and the
virtual shelf (neighbouring call numbers)."""

from __future__ import annotations

import re
import threading
from collections import Counter
from urllib.parse import quote

from sqlalchemy import String, cast, func, select, text
from sqlalchemy.orm import Session

from ..db import fts_available
from ..models import Biblio, Item, ItemStatus

_WORD = re.compile(r"[^\W\d_]{2,}", re.UNICODE)
_TOKEN = re.compile(r"\w+", re.UNICODE)
_RESERVED = {"and", "or", "not", "near"}


def _tokens(q: str) -> list[str]:
    return [t for t in _TOKEN.findall(q.lower()) if t not in _RESERVED]


def _fts_expr(column: str, tokens: list[str]) -> str:
    """FTS5 column-filtered prefix query, e.g. ``title : ("great" "gat"*)``. Tokens are \\w-only so quoting is safe."""
    parts = [f'"{t}"' for t in tokens[:-1]] + [f'"{tokens[-1]}"*']
    return f"{column} : ({' '.join(parts)})"


def _starts_words(value: str, tokens: list[str]) -> bool:
    """Every query token is a prefix of some word in ``value`` (last token) or an exact word (others)."""
    words = [w.lower() for w in _TOKEN.findall(value)]
    *full, last = tokens
    return all(t in words or any(w.startswith(t) for w in words) for t in full) and any(w.startswith(last) for w in words)


def suggest(db: Session, q: str, limit: int = 8) -> list[dict]:
    tokens = _tokens(q or "")
    if not tokens or len("".join(tokens)) < 2:
        return []
    out: list[dict] = []
    if fts_available(db.get_bind()):
        def ids_for(column: str, n: int) -> list[int]:
            rows = db.execute(text("SELECT rowid FROM biblio_fts WHERE biblio_fts MATCH :m ORDER BY bm25(biblio_fts, 10.0, 6.0, 4.0, 1.0, 1.5, 10.0, 2.0) LIMIT :n"),
                              {"m": _fts_expr(column, tokens), "n": n}).all()
            return [r[0] for r in rows]

        title_ids = ids_for("title", 6)
        author_ids = ids_for("authors", 40)
        subject_ids = ids_for("subjects", 40)
    else:
        like = f"%{q.strip().lower()}%"
        title_ids = list(db.scalars(select(Biblio.id).where(Biblio.deleted_at.is_(None), func.lower(Biblio.title).like(like)).limit(6)))
        author_ids = list(db.scalars(select(Biblio.id).where(Biblio.deleted_at.is_(None), func.lower(cast(Biblio.authors, String)).like(like)).limit(40)))
        subject_ids = list(db.scalars(select(Biblio.id).where(Biblio.deleted_at.is_(None), func.lower(cast(Biblio.subjects, String)).like(like)).limit(40)))
    wanted = set(title_ids) | set(author_ids) | set(subject_ids)
    rows = {r.id: r for r in db.execute(select(Biblio.id, Biblio.title, Biblio.authors, Biblio.subjects, Biblio.pub_year)
                                        .where(Biblio.id.in_(wanted), Biblio.deleted_at.is_(None))).all()} if wanted else {}
    authors: Counter = Counter()
    for bid in author_ids:
        for a in (rows[bid].authors or []) if bid in rows else []:
            if _starts_words(a, tokens):
                authors[a] += 1
    subjects: Counter = Counter()
    for bid in subject_ids:
        for s in (rows[bid].subjects or []) if bid in rows else []:
            head = s.split(" -- ")[0].strip()
            if _starts_words(head, tokens):
                subjects[head] += 1
    n_titles = max(limit - min(2, len(authors)) - min(2, len(subjects)), 3)
    seen_titles: set[str] = set()
    for bid in title_ids:
        r = rows.get(bid)
        if r and r.title.lower() not in seen_titles and len([o for o in out if o["kind"] == "title"]) < n_titles:
            seen_titles.add(r.title.lower())
            out.append({"kind": "title", "label": r.title, "id": r.id, "detail": "; ".join((r.authors or [])[:1]),
                        "year": r.pub_year, "href": f"/record/{r.id}"})
    out += [{"kind": "author", "label": a, "href": f"/search?author={quote(a)}"} for a, _ in authors.most_common(2)]
    out += [{"kind": "subject", "label": s, "href": f"/search?subject={quote(s)}"} for s, _ in subjects.most_common(2)]
    return out[:limit]


# ------------------------------------------------------------------ did you mean


class _Vocabulary:
    """Word frequencies from titles, authors and subjects; rebuilt when the catalogue changes."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._key: tuple | None = None
        self.counts: Counter = Counter()
        self.words: list[str] = []

    def get(self, db: Session) -> _Vocabulary:
        key = tuple(db.execute(select(func.count(Biblio.id), func.max(Biblio.updated_at)).where(Biblio.deleted_at.is_(None))).one())
        with self._lock:
            if key != self._key:
                counts: Counter = Counter()
                for title, subtitle, authors, subjects in db.execute(select(Biblio.title, Biblio.subtitle, Biblio.authors, Biblio.subjects)
                                                                     .where(Biblio.deleted_at.is_(None)).limit(500_000)):
                    blob = " ".join([title or "", subtitle or "", *(authors or []), *(subjects or [])])
                    counts.update(w.lower() for w in _WORD.findall(blob))
                self.counts, self.words, self._key = counts, list(counts), key
        return self

    def invalidate(self) -> None:
        with self._lock:
            self._key = None


vocabulary = _Vocabulary()


def did_you_mean(db: Session, q: str) -> str | None:
    """A respelling of ``q`` using catalogue vocabulary, or None if every word is already known."""
    from rapidfuzz import fuzz, process

    vocab = vocabulary.get(db)
    if not vocab.words:
        return None
    changed = False
    out: list[str] = []
    for token in _TOKEN.findall(q or ""):
        low = token.lower()
        if low in vocab.counts or len(low) < 3 or not _WORD.fullmatch(low):
            out.append(token)
            continue
        cutoff = 72 if len(low) >= 6 else 66
        candidates = process.extract(low, vocab.words, scorer=fuzz.ratio, limit=5, score_cutoff=cutoff)
        if not candidates:
            out.append(token)
            continue
        best = max(candidates, key=lambda c: (round(c[1]), vocab.counts[c[0]]))[0]
        out.append(best)
        changed = True
    return " ".join(out) if changed else None


# ------------------------------------------------------------------ virtual shelf


def shelf(db: Session, biblio: Biblio, n: int = 6, branch_id: int | None = None) -> dict:
    """Titles shelved either side of ``biblio`` by call number (string order, as on a physical shelf)."""
    items = [i for i in biblio.items if i.deleted_at is None and i.status != ItemStatus.withdrawn]
    if branch_id:
        items = [i for i in items if i.branch_id == branch_id]
    anchor_item = next((i for i in items if i.call_number), None)
    anchor = (anchor_item.call_number if anchor_item else None) or biblio.classification
    if not anchor:
        return {"anchor": None, "before": [], "after": []}
    base = [Item.deleted_at.is_(None), Item.call_number.is_not(None), Item.status != ItemStatus.withdrawn,
            Item.biblio_id != biblio.id, Biblio.deleted_at.is_(None)]
    if branch_id:
        base.append(Item.branch_id == branch_id)

    def side(cmp, order) -> list[tuple[int, str]]:
        rows = db.execute(select(Item.biblio_id, Item.call_number).join(Biblio, Biblio.id == Item.biblio_id)
                          .where(*base, cmp).order_by(order, Item.biblio_id).limit(n * 5)).all()
        seen: dict[int, str] = {}
        for bid, cn in rows:
            if bid not in seen:
                seen[bid] = cn
            if len(seen) >= n:
                break
        return list(seen.items())

    before = side(Item.call_number < anchor, Item.call_number.desc())[::-1]
    after = side(Item.call_number >= anchor, Item.call_number.asc())
    return {"anchor": anchor, "before": before, "after": after}
