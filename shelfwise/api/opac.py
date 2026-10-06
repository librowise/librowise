"""Patron self-service (the OPAC "my account")."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..ai import recommend
from ..db import get_db
from ..deps import current_user, optional_user
from ..errors import NotFound
from ..models import Hold, LedgerEntry, Loan, Patron, ReadingList, ReadingListEntry, Review
from ..schemas import HoldIn, ListIn, ReviewIn, biblio_out, hold_out, loan_out, money
from ..services import catalog, circulation
from ..services import settings as settings_svc

router = APIRouter(prefix="/opac", tags=["opac"])


@router.get("/config")
def config(db: Session = Depends(get_db)):
    return {k: settings_svc.get(db, k) for k in (
        "library_name", "opac_announcement", "allow_patron_self_renewal", "allow_reviews", "ai_opac_enabled")}


@router.get("/home")
def home(db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    """Landing-page shelves: trending, new arrivals and (if signed in) personal picks."""
    trending_ids = [b for b, _ in recommend.trending(db, days=120, limit=12)]
    new_ids = catalog.search(db, None, page=1, per_page=12, sort="newest").ids
    shelves = [{"key": "trending", "title": "Trending now", "ids": trending_ids},
               {"key": "new", "title": "New arrivals", "ids": new_ids}]
    if user is not None:
        recs = recommend.for_patron(db, user.id, limit=12)
        shelves.insert(0, {"key": "for_you", "title": "Picked for you", "ids": recs["ids"]})
    all_ids = list({i for s in shelves for i in s["ids"]})
    avail = catalog.availability(db, all_ids)
    by_id = {b.id: biblio_out(b, avail.get(b.id)) for b in catalog.load_biblios(db, all_ids)}
    return {"shelves": [{"key": s["key"], "title": s["title"],
                         "results": [by_id[i] for i in s["ids"] if i in by_id]} for s in shelves if s["ids"]]}


@router.get("/me/summary")
def summary(user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    holds = db.scalars(select(Hold).where(Hold.patron_id == user.id, Hold.status.in_(circulation.ACTIVE_HOLD_STATUSES))
                       .order_by(Hold.created_at)).all()
    ledger = db.scalars(select(LedgerEntry).where(LedgerEntry.patron_id == user.id)
                        .order_by(LedgerEntry.created_at.desc()).limit(50)).all()
    return {
        "loans": [loan_out(l) for l in circulation.open_loans(db, user.id)],
        "holds": [hold_out(h, circulation.hold_queue_position(db, h)) for h in holds],
        "balance": money(circulation.balance(db, user.id)),
        "ledger": [{"kind": e.kind.value, "amount": money(e.amount), "note": e.note, "created_at": e.created_at} for e in ledger],
        "blocks": circulation.patron_blocks(db, user),
    }


@router.get("/me/history")
def my_history(user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    loans = db.scalars(select(Loan).where(Loan.patron_id == user.id, Loan.returned_at.is_not(None))
                       .order_by(Loan.returned_at.desc()).limit(200)).all()
    return {"keep_history": user.keep_history, "results": [loan_out(l) for l in loans]}


@router.delete("/me/history")
def clear_history(user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    n = db.query(Loan).filter(Loan.patron_id == user.id, Loan.returned_at.is_not(None)).update({"patron_id": None})
    db.commit()
    return {"anonymized": n}


@router.post("/me/loans/{loan_id}/renew")
def renew_own(loan_id: int, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    if not settings_svc.get(db, "allow_patron_self_renewal"):
        raise HTTPException(403, "Online renewal is disabled — please contact the library")
    loan = db.get(Loan, loan_id)
    if loan is None or loan.patron_id != user.id:
        raise NotFound("Loan not found")
    circulation.renew(db, loan, actor=user)
    db.commit()
    return loan_out(loan)


@router.post("/me/holds", status_code=201)
def hold_own(body: HoldIn, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    biblio = catalog.get_biblio(db, body.biblio_id)
    hold = circulation.place_hold(db, user, biblio, pickup_branch_id=body.pickup_branch_id, actor=user,
                                  notes=body.notes, item_id=body.item_id, not_needed_after=body.not_needed_after)
    db.commit()
    return hold_out(hold, circulation.hold_queue_position(db, hold))


@router.delete("/me/holds/{hold_id}")
def cancel_own(hold_id: int, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    hold = db.get(Hold, hold_id)
    if hold is None or hold.patron_id != user.id:
        raise NotFound("Hold not found")
    circulation.cancel_hold(db, hold, actor=user)
    db.commit()
    return {"ok": True}


@router.get("/me/recommendations")
def my_recs(user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    rec = recommend.for_patron(db, user.id)
    avail = catalog.availability(db, rec["ids"])
    return {"reason": rec["reason"], "results": [biblio_out(b, avail.get(b.id)) for b in catalog.load_biblios(db, rec["ids"])]}


# ------------------------------------------------------------------ reviews


@router.post("/biblios/{biblio_id}/review")
def review(biblio_id: int, body: ReviewIn, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    if not settings_svc.get(db, "allow_reviews"):
        raise HTTPException(403, "Reviews are disabled")
    catalog.get_biblio(db, biblio_id)
    r = db.scalar(select(Review).where(Review.patron_id == user.id, Review.biblio_id == biblio_id))
    if r is None:
        r = Review(patron_id=user.id, biblio_id=biblio_id, rating=body.rating)
        db.add(r)
    r.rating, r.body = body.rating, body.body
    r.approved = not settings_svc.get(db, "reviews_require_approval")
    db.commit()
    return {"id": r.id, "approved": r.approved}


# ------------------------------------------------------------------ reading lists


def _list_out(rl: ReadingList, db: Session) -> dict:
    ids = [e.biblio_id for e in rl.entries]
    avail = catalog.availability(db, ids)
    return {"id": rl.id, "name": rl.name, "is_public": rl.is_public, "count": len(ids),
            "results": [biblio_out(b, avail.get(b.id)) for b in catalog.load_biblios(db, ids)]}


@router.get("/me/lists")
def my_lists(user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    return {"results": [_list_out(rl, db) for rl in db.scalars(select(ReadingList).where(ReadingList.owner_id == user.id))]}


@router.post("/me/lists", status_code=201)
def create_list(body: ListIn, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    rl = ReadingList(owner_id=user.id, name=body.name, is_public=body.is_public)
    db.add(rl)
    db.commit()
    return _list_out(rl, db)


def _own_list(db: Session, list_id: int, user: Patron) -> ReadingList:
    rl = db.get(ReadingList, list_id)
    if rl is None or rl.owner_id != user.id:
        raise NotFound("List not found")
    return rl


@router.post("/me/lists/{list_id}/items/{biblio_id}")
def add_to_list(list_id: int, biblio_id: int, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    rl = _own_list(db, list_id, user)
    catalog.get_biblio(db, biblio_id)
    if not any(e.biblio_id == biblio_id for e in rl.entries):
        rl.entries.append(ReadingListEntry(biblio_id=biblio_id))
    db.commit()
    return _list_out(rl, db)


@router.delete("/me/lists/{list_id}/items/{biblio_id}")
def remove_from_list(list_id: int, biblio_id: int, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    rl = _own_list(db, list_id, user)
    rl.entries = [e for e in rl.entries if e.biblio_id != biblio_id]
    db.commit()
    return _list_out(rl, db)


@router.delete("/me/lists/{list_id}")
def delete_list(list_id: int, user: Patron = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(_own_list(db, list_id, user))
    db.commit()
    return {"ok": True}


@router.get("/lists/public")
def public_lists(db: Session = Depends(get_db)):
    return {"results": [_list_out(rl, db) for rl in db.scalars(select(ReadingList).where(ReadingList.is_public.is_(True)).limit(50))]}
