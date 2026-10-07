"""Collection & circulation intelligence: overdue risk, demand, weeding and duplicates."""

from __future__ import annotations

import math
import re
import time
from collections import defaultdict
from datetime import timedelta

from rapidfuzz import fuzz
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Biblio, Hold, HoldStatus, Item, ItemStatus, Loan, utcnow

# ------------------------------------------------------------------ overdue risk


_LATE_STATS_TTL = 300.0  # seconds; history changes slowly, the dashboard asks often
_late_stats_cache: dict[str, tuple[float, dict[int, tuple[int, int]]]] = {}


def _patron_late_stats(db: Session, patron_ids: set[int]) -> dict[int, tuple[int, int]]:
    if not patron_ids:
        return {}
    large = len(patron_ids) > 500
    key = db.get_bind().url.render_as_string(hide_password=True)
    if large and get_settings().environment != "test":
        hit = _late_stats_cache.get(key)
        if hit and time.monotonic() - hit[0] < _LATE_STATS_TTL:
            return {p: s for p, s in hit[1].items() if p in patron_ids}
    # Large sets use a semi-join on "patrons with open loans" instead of a huge IN (...) list;
    # the aggregate is an index-only scan of loans(patron_id, returned_at, due_at).
    who = (Loan.patron_id.in_(select(Loan.patron_id).where(Loan.returned_at.is_(None))) if large else
           Loan.patron_id.in_(patron_ids))
    rows = db.execute(
        select(
            Loan.patron_id,
            func.count(Loan.id),
            func.sum(case((Loan.returned_at > Loan.due_at, 1), else_=0)),
        )
        .where(who, Loan.returned_at.is_not(None))
        .group_by(Loan.patron_id)
    ).all()
    stats = {pid: (int(total or 0), int(late or 0)) for pid, total, late in rows}
    if large:
        _late_stats_cache[key] = (time.monotonic(), stats)
    return {p: s for p, s in stats.items() if p in patron_ids}


def overdue_risk(db: Session, limit: int = 50) -> list[dict]:
    """Score open, not-yet-overdue loans by probability of being returned late.

    A transparent logistic model over: the patron's historical late-return rate (with a
    Bayesian prior), renewals already used, days remaining and current overdue loans.
    Scoring runs over light tuples; full loan objects are loaded only for the top ``limit``.
    """
    now = utcnow()
    loans = [r for r in db.execute(select(Loan.id, Loan.patron_id, Loan.due_at, Loan.renewals)
                                   .where(Loan.returned_at.is_(None))).all() if r.patron_id is not None]
    stats = _patron_late_stats(db, {l.patron_id for l in loans if l.patron_id})
    overdue_now: dict[int, int] = defaultdict(int)
    for l in loans:
        if l.due_at < now:
            overdue_now[l.patron_id] += 1
    scored = []
    for l in loans:
        if l.due_at < now:
            continue
        total, late = stats.get(l.patron_id, (0, 0))
        late_rate = (late + 1) / (total + 5)  # prior: 20% late
        days_left = (l.due_at - now).days
        z = (-2.2 + 4.0 * late_rate + 0.6 * l.renewals + 0.9 * min(overdue_now[l.patron_id], 3)
             - 0.05 * days_left)
        scored.append((1 / (1 + math.exp(-z)), l, late_rate, days_left))
    scored.sort(key=lambda r: -r[0])
    top = scored[:limit]
    full = {l.id: l for l in db.scalars(select(Loan).where(Loan.id.in_([r[1].id for r in top])))} if top else {}
    out = []
    for p, l, late_rate, days_left in top:
        loan = full[l.id]
        out.append({
            "loan_id": l.id,
            "patron": loan.patron.full_name if loan.patron else None,
            "patron_id": l.patron_id,
            "title": loan.item.biblio.title,
            "barcode": loan.item.barcode,
            "due_at": l.due_at,
            "risk": round(p, 3),
            "level": "high" if p >= 0.5 else "medium" if p >= 0.25 else "low",
            "factors": {
                "historical_late_rate": round(late_rate, 2),
                "renewals": l.renewals,
                "currently_overdue": overdue_now[l.patron_id],
                "days_left": days_left,
            },
        })
    return out


# ------------------------------------------------------------------ acquisitions & weeding


def purchase_suggestions(db: Session, limit: int = 20) -> list[dict]:
    """Titles where hold demand outstrips copies (classic holds-ratio purchase alert)."""
    holds = dict(db.execute(
        select(Hold.biblio_id, func.count()).where(Hold.status.in_((HoldStatus.queued, HoldStatus.ready)))
        .group_by(Hold.biblio_id)
    ).all())
    if not holds:
        return []
    copies = dict(db.execute(
        select(Item.biblio_id, func.count()).where(
            Item.biblio_id.in_(holds), Item.deleted_at.is_(None),
            Item.status.not_in((ItemStatus.withdrawn, ItemStatus.lost)))
        .group_by(Item.biblio_id)
    ).all())
    out = []
    for bid, n_holds in holds.items():
        n_copies = copies.get(bid, 0)
        ratio = n_holds / max(n_copies, 1)
        if ratio >= 2 or n_copies == 0:
            b = db.get(Biblio, bid)
            out.append({
                "biblio_id": bid, "title": b.title if b else "?", "holds": n_holds, "copies": n_copies,
                "ratio": round(ratio, 2), "suggested_copies": max(1, math.ceil(n_holds / 2) - n_copies),
            })
    out.sort(key=lambda r: -r["ratio"])
    return out[:limit]


def weeding_candidates(db: Session, idle_days: int = 730, limit: int = 50) -> list[dict]:
    """Items not borrowed for ``idle_days`` and held for at least that long (CREW-style)."""
    cutoff = utcnow() - timedelta(days=idle_days)
    last_loan = (
        select(Loan.item_id, func.max(Loan.issued_at).label("last"))
        .group_by(Loan.item_id).subquery()
    )
    rows = db.execute(
        select(Item, last_loan.c.last)
        .outerjoin(last_loan, last_loan.c.item_id == Item.id)
        .where(Item.deleted_at.is_(None), Item.status == ItemStatus.available,
               Item.created_at < cutoff,
               (last_loan.c.last.is_(None)) | (last_loan.c.last < cutoff))
        .limit(limit)
    ).all()
    return [{"item_id": i.id, "barcode": i.barcode, "title": i.biblio.title,
             "last_borrowed": last, "times_borrowed": i.times_borrowed} for i, last in rows]


# ------------------------------------------------------------------ duplicates


def _norm(s: str) -> str:
    s = re.sub(r"[^\w\s]", " ", (s or "").lower())
    s = re.sub(r"^(the|a|an)\s+", "", s.strip())
    return " ".join(s.split())


def duplicate_candidates(db: Session, threshold: int = 90, limit: int = 50) -> list[dict]:
    """Likely duplicate bibliographic records (same ISBN, or near-identical title+author).

    Uses blocking on the first title word to avoid O(n²) comparisons on large catalogues.
    """
    biblios = list(db.execute(
        select(Biblio.id, Biblio.title, Biblio.authors, Biblio.isbn, Biblio.pub_year)
        .where(Biblio.deleted_at.is_(None))
    ).all())
    out, seen = [], set()
    by_isbn: dict[str, list] = defaultdict(list)
    blocks: dict[str, list] = defaultdict(list)
    for b in biblios:
        if b.isbn:
            by_isbn[b.isbn].append(b)
        key = (_norm(b.title).split() or [""])[0][:6]
        blocks[key].append(b)
    for isbn, group in by_isbn.items():
        if len(group) > 1:
            pair = tuple(sorted(x.id for x in group[:2]))
            seen.add(pair)
            out.append({"ids": list(pair), "titles": [g.title for g in group[:2]], "score": 100, "reason": f"Same ISBN {isbn}"})
    for group in blocks.values():
        if len(group) < 2 or len(group) > 400:
            continue
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                pair = tuple(sorted((a.id, b.id)))
                if pair in seen:
                    continue
                t = fuzz.token_sort_ratio(_norm(a.title), _norm(b.title))
                if t < threshold:
                    continue
                au = fuzz.token_set_ratio(" ".join(a.authors or []), " ".join(b.authors or []))
                score = round(0.7 * t + 0.3 * au)
                if score >= threshold:
                    seen.add(pair)
                    out.append({"ids": list(pair), "titles": [a.title, b.title], "score": score,
                                "reason": "Similar title and author"})
    out.sort(key=lambda r: -r["score"])
    return out[:limit]
