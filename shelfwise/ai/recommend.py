"""Hybrid recommendations: collaborative filtering on loans + content similarity + popularity."""

from __future__ import annotations

from collections import defaultdict
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


MAX_READERS = 400  # most recent readers considered for co-borrowing (bounds the work for bestsellers)
MAX_CANDIDATES = 500  # co-borrowed titles re-scored by lift


def also_borrowed(db: Session, biblio_id: int, limit: int = 10, since_days: int = 730) -> list[tuple[int, float]]:
    """"Readers who borrowed this also borrowed…", computed in SQL over the loans index:
    co-borrow counts among this title's readers, normalised by popularity (lift) so bestsellers
    don't dominate every list. Cost is bounded by MAX_READERS × their loans, not the loan table."""
    since = utcnow() - timedelta(days=since_days)
    readers = list(db.scalars(
        select(Loan.patron_id).join(Item, Item.id == Loan.item_id)
        .where(Item.biblio_id == biblio_id, Loan.patron_id.is_not(None), Loan.issued_at >= since)
        .group_by(Loan.patron_id).order_by(func.max(Loan.issued_at).desc()).limit(MAX_READERS)
    ))
    if not readers:
        return []
    n = func.count().label("n")
    co_q = (select(Item.biblio_id, n).join(Loan, Loan.item_id == Item.id)
            .where(Loan.patron_id.in_(readers), Loan.issued_at >= since, Item.biblio_id != biblio_id)
            .group_by(Item.biblio_id))
    if len(readers) >= 3:
        co_q = co_q.having(func.count() >= 2)  # minimum support
    co = dict(db.execute(co_q.order_by(n.desc(), Item.biblio_id).limit(MAX_CANDIDATES)).all())
    if not co:
        return []
    popularity = dict(db.execute(
        select(Item.biblio_id, func.count()).join(Loan, Loan.item_id == Item.id)
        .where(Item.biblio_id.in_(list(co)), Loan.patron_id.is_not(None), Loan.issued_at >= since)
        .group_by(Item.biblio_id)
    ).all())
    scored = {b: c / (popularity.get(b, c) ** 0.5) for b, c in co.items()}
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
