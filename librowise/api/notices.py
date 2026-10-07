"""Notices API: template editor + preview, delivery outbox, and patron messaging preferences."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound
from ..models import Patron
from ..schemas import StrictModel
from ..services import notices

router = APIRouter(tags=["notices"])
CODE = "^[A-Z_]{2,40}$"
CHANNEL = "^(email|sms)$"


class TemplateIn(StrictModel):
    subject: str = Field(default="", max_length=255)
    body: str = Field(min_length=1, max_length=20000)
    is_active: bool = True


class PreviewIn(StrictModel):
    code: str = Field(pattern=CODE)
    channel: str = Field(default="email", pattern=CHANNEL)
    subject: str = Field(default="", max_length=255)
    body: str = Field(default="", max_length=20000)
    patron_card: str | None = Field(default=None, max_length=32, description="Preview with a real patron's details")


class PreferencesIn(StrictModel):
    preferences: dict[str, str] = Field(description="notice code → email | sms | none")


def _patron(db: Session, patron_id: int) -> Patron:
    p = db.get(Patron, patron_id)
    if p is None or p.deleted_at is not None:
        raise NotFound("Patron not found")
    return p


# ------------------------------------------------------------------ templates


@router.get("/notices/templates")
def templates(db: Session = Depends(get_db), _: Patron = Depends(require("notices:outbox"))):
    return {"codes": [{"code": c, "name": n, "patron_configurable": cfg, "description": d}
                      for c, (n, cfg, d) in notices.CODES.items()],
            "channels": list(notices.CHANNELS), "results": notices.list_templates(db)}


@router.put("/notices/templates/{code}/{channel}")
def save_template(body: TemplateIn, code: str = Path(pattern=CODE), channel: str = Path(pattern=CHANNEL),
                  db: Session = Depends(get_db), user: Patron = Depends(require("notices:manage"))):
    out = notices.save_template(db, code, channel, subject=body.subject, body=body.body, is_active=body.is_active,
                                actor=user)
    db.commit()
    return out


@router.delete("/notices/templates/{code}/{channel}")
def reset_template(code: str = Path(pattern=CODE), channel: str = Path(pattern=CHANNEL),
                   db: Session = Depends(get_db), user: Patron = Depends(require("notices:manage"))):
    out = notices.reset_template(db, code, channel, actor=user)
    db.commit()
    return out


@router.post("/notices/preview")
def preview(body: PreviewIn, db: Session = Depends(get_db), _: Patron = Depends(require("notices:outbox"))):
    patron = None
    if body.patron_card:
        patron = db.scalar(select(Patron).where(Patron.card_number == body.patron_card.strip(),
                                                Patron.deleted_at.is_(None)))
        if patron is None:
            raise NotFound("No patron with that card number")
    return notices.preview(db, body.code, body.channel, body.subject, body.body, patron)


# ------------------------------------------------------------------ outbox


@router.get("/notices/outbox")
def outbox(status: str | None = Query(default=None, pattern="^(pending|sent|failed)$"),
           channel: str | None = Query(default=None, pattern=CHANNEL),
           code: str | None = Query(default=None, pattern=CODE), patron_card: str | None = Query(default=None, max_length=32),
           page: int = Query(default=1, ge=1), per_page: int = Query(default=50, ge=1, le=200),
           db: Session = Depends(get_db), _: Patron = Depends(require("notices:outbox"))):
    patron_id = None
    if patron_card:
        patron_id = db.scalar(select(Patron.id).where(Patron.card_number == patron_card.strip()))
        if patron_id is None:
            return {"total": 0, "page": page, "counts": {}, "results": []}
    return notices.outbox(db, status=status, channel=channel, code=code, patron_id=patron_id, page=page,
                          per_page=per_page)


@router.post("/notices/outbox/{notification_id}/resend")
def resend(notification_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("notices:outbox"))):
    n = notices.resend(db, notification_id, actor=user)
    db.commit()
    return notices.notification_out(n)


@router.post("/notices/outbox/deliver")
def deliver(limit: int = Query(default=50, ge=1, le=500), db: Session = Depends(get_db),
            user: Patron = Depends(require("notices:manage"))):
    """Process the outbox now (normally done by the job worker / `python -m librowise send-notices`)."""
    from ..services import audit

    stats = notices.deliver_pending(db, limit)
    audit.record(db, "notices_delivered", "notification", None, actor=user, **stats)
    db.commit()
    return stats


# ------------------------------------------------------------------ messaging preferences


@router.get("/opac/me/messaging")
def my_messaging(db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    return {"email": user.email, "phone": user.phone, "results": notices.get_preferences(db, user)}


@router.put("/opac/me/messaging")
def set_my_messaging(body: PreferencesIn, db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    out = notices.set_preferences(db, user, body.preferences, actor=user)
    db.commit()
    return {"email": user.email, "phone": user.phone, "results": out}


@router.get("/patrons/{patron_id}/messaging")
def patron_messaging(patron_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("patrons:read"))):
    p = _patron(db, patron_id)
    return {"email": p.email, "phone": p.phone, "results": notices.get_preferences(db, p)}


@router.put("/patrons/{patron_id}/messaging")
def set_patron_messaging(patron_id: int, body: PreferencesIn, db: Session = Depends(get_db),
                         user: Patron = Depends(require("patrons:write"))):
    p = _patron(db, patron_id)
    out = notices.set_preferences(db, p, body.preferences, actor=user)
    db.commit()
    return {"email": p.email, "phone": p.phone, "results": out}


@router.get("/patrons/{patron_id}/notices")
def patron_notices(patron_id: int, page: int = Query(default=1, ge=1), db: Session = Depends(get_db),
                   _: Patron = Depends(require("notices:outbox"))):
    _patron(db, patron_id)
    return notices.outbox(db, patron_id=patron_id, page=page, per_page=50)
