"""Hybrid recommendations: collaborative filtering on loans + content similarity + popularity."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Item, Loan, utcnow
from . import semantic


def _loan_pairs(db: Session, since_days: int = 730) -> list[tuple[int, int]]:
    since = utcnow() - timedelta(days=since_days)
    return list(
        db.execute(
            select(Loan.patron_id, Item.biblio_id)
            .join(Item, Item.id == Loan.item_id)
            .where(Loan.patron_id.is_not(None), Loan.issued_at >= since)
        ).all()
    )


def also_borrowed(db: Session, biblio_id: int, limit: int = 10) -> list[tuple[int, float]]:
    pairs = _loan_pairs(db)
    readers = {p for p, b in pairs if b == biblio_id}
    if not readers:
        return []
    popularity = Counter(b for _, b in pairs)
    co = Counter(b for p, b in pairs if p in readers and b != biblio_id)
    co = Counter({b: c for b, c in co.items() if c >= 2 or len(readers) < 3})  # minimum support
    # Normalise by popularity (lift) so bestsellers don't dominate every list
    scored = {b: c / (popularity[b] ** 0.5) for b, c in co.items()}
    return sorted(scored.items(), key=lambda kv: -kv[1])[:limit]


def for_biblio(db: Session, biblio_id: int, limit: int = 8) -> dict:
    collab = [b for b, _ in also_borrowed(db, biblio_id, limit * 2)]
    content = [b for b, _ in semantic.index.similar(db, biblio_id, limit * 2)]
    fused = semantic.reciprocal_rank_fusion(content, content, collab)  # content weighted 2:1
    return {"ids": fused[:limit], "collaborative": len(collab), "content": len(content)}


def trending(db: Session, days: int = 90, limit: int = 10) -> list[tuple[int, int]]:
    since = utcnow() - timedelta(days=days)
    rows = db.execute(
        select(Item.biblio_id, func.count(Loan.id))
        .join(Loan, Loan.item_id == Item.id)
        .where(Loan.issued_at >= since)
        .group_by(Item.biblio_id)
        .order_by(func.count(Loan.id).desc())
        .limit(limit)
    ).all()
    return [(b, n) for b, n in rows]


def for_patron(db: Session, patron_id: int, limit: int = 12) -> dict:
    history = list(
        db.scalars(
            select(Item.biblio_id)
            .join(Loan, Loan.item_id == Item.id)
            .where(Loan.patron_id == patron_id)
            .order_by(Loan.issued_at.desc())
            .limit(30)
        )
    )
    seen = set(history)
    if not history:
        return {"ids": [b for b, _ in trending(db, limit=limit)], "reason": "trending"}
    scores: dict[int, float] = defaultdict(float)
    for rank, bid in enumerate(history[:10]):
        recency = 1.0 / (1 + rank * 0.3)
        for other, s in semantic.index.similar(db, bid, 15):
            scores[other] += s * recency
        for other, s in also_borrowed(db, bid, 15):
            scores[other] += 0.5 * s * recency
    for b in seen:
        scores.pop(b, None)
    ranked = [b for b, _ in sorted(scores.items(), key=lambda kv: -kv[1])]
    if len(ranked) < limit:
        ranked += [b for b, _ in trending(db, limit=limit * 2) if b not in seen and b not in ranked]
    return {"ids": ranked[:limit], "reason": "personalised"}
