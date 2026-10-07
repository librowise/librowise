"""OPAC self-registration (public, rate-limited) and the staff approval queue."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import EmailStr, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, require
from ..models import Patron
from ..schemas import StrictModel
from ..services import registration
from ..services import settings as settings_svc

router = APIRouter(tags=["registration"])


class RegisterIn(StrictModel):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=40, pattern=r"^[0-9+()\-. ]*$")
    address: str | None = Field(default=None, max_length=255)
    date_of_birth: date | None = None
    home_branch_id: int
    password: str = Field(min_length=1, max_length=256)
    website: str | None = Field(default=None, max_length=200, description="Leave empty (spam trap)")


class ApproveIn(StrictModel):
    category_id: int | None = None
    home_branch_id: int | None = None
    note: str | None = Field(default=None, max_length=500)


class RejectIn(StrictModel):
    reason: str = Field(min_length=1, max_length=500)


ACCEPTED = {"ok": True, "status": "pending",
            "message": "Thank you! Your registration has been received. Library staff will review it and email "
                       "you when your account is ready."}


@router.get("/opac/register/config")
def register_config(db: Session = Depends(get_db)):
    return {"enabled": bool(settings_svc.get(db, "allow_self_registration")),
            "library_name": settings_svc.get(db, "library_name")}


@router.post("/opac/register", status_code=201)
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)):
    ip = client_ip(request)
    if not registration.registration_limiter.allow(f"reg:{ip}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            "Too many registrations from this network. Please try again later.")
    if body.website:  # honeypot field filled in → a bot; pretend success, store nothing
        return ACCEPTED
    registration.register(db, body.model_dump(exclude={"website"}), ip=ip)
    db.commit()
    return ACCEPTED


@router.get("/registrations")
def registrations(status_: str | None = Query(default="pending", alias="status",
                                              pattern="^(pending|approved|rejected|all)$"),
                  db: Session = Depends(get_db), _: Patron = Depends(require("patrons:approve"))):
    return {"pending": registration.pending_count(db),
            "results": registration.list_registrations(db, None if status_ == "all" else status_)}


@router.get("/registrations/count")
def registrations_count(db: Session = Depends(get_db), _: Patron = Depends(require("patrons:approve"))):
    return {"pending": registration.pending_count(db)}


@router.post("/registrations/{patron_id}/approve")
def approve(patron_id: int, body: ApproveIn, db: Session = Depends(get_db),
            user: Patron = Depends(require("patrons:approve"))):
    p = registration.approve(db, patron_id, actor=user, category_id=body.category_id,
                             home_branch_id=body.home_branch_id, note=body.note)
    db.commit()
    return {"ok": True, "patron_id": p.id, "card_number": p.card_number, "status": p.registration_status}


@router.post("/registrations/{patron_id}/reject")
def reject(patron_id: int, body: RejectIn, db: Session = Depends(get_db),
           user: Patron = Depends(require("patrons:approve"))):
    p = registration.reject(db, patron_id, actor=user, reason=body.reason)
    db.commit()
    return {"ok": True, "patron_id": p.id, "status": p.registration_status}
