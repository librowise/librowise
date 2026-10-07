"""Purchase suggestions: patron form + list (OPAC) and the staff review queue."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..models import Patron
from ..schemas import StrictModel
from ..security import has_permission
from ..services import suggestions

router = APIRouter(tags=["suggestions"])


class SuggestionIn(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    author: str | None = Field(default=None, max_length=255)
    isbn: str | None = Field(default=None, max_length=20, pattern=r"^[0-9Xx\- ]*$")
    format: str = Field(default="book", pattern="^(book|ebook|audiobook|dvd|serial|comic|other)$")
    reason: str | None = Field(default=None, max_length=2000)


class AcceptIn(StrictModel):
    note: str | None = Field(default=None, max_length=500)
    create_order: bool = False
    vendor_id: int | None = None
    budget_id: int | None = None
    quantity: int = Field(default=1, ge=1, le=1000)
    unit_price: int | None = Field(default=None, ge=0, description="Minor units (paise/cents)")


class RejectIn(StrictModel):
    reason: str = Field(min_length=1, max_length=500)


# ------------------------------------------------------------------ patron


@router.get("/opac/me/suggestions")
def my_suggestions(db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    return {"results": suggestions.for_patron(db, user)}


@router.post("/opac/me/suggestions", status_code=201)
def suggest(body: SuggestionIn, db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    s = suggestions.create(db, user, body.model_dump())
    db.commit()
    return suggestions.suggestion_out(s)


@router.delete("/opac/me/suggestions/{suggestion_id}")
def withdraw(suggestion_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("opac"))):
    s = suggestions.withdraw(db, suggestions.get(db, suggestion_id), patron=user)
    db.commit()
    return suggestions.suggestion_out(s)


# ------------------------------------------------------------------ staff


@router.get("/suggestions")
def staff_list(status: str | None = Query(default=None, pattern="^(pending|accepted|ordered|rejected|withdrawn)$"),
               db: Session = Depends(get_db), _: Patron = Depends(require("suggestions:manage"))):
    return suggestions.staff_list(db, status)


@router.post("/suggestions/{suggestion_id}/accept")
def accept(suggestion_id: int, body: AcceptIn, db: Session = Depends(get_db),
           user: Patron = Depends(require("suggestions:manage"))):
    order = None
    if body.create_order:
        if not has_permission(user, "acquisitions:write"):
            raise HTTPException(403, "Missing permission: acquisitions:write")
        if body.vendor_id is None or body.budget_id is None or body.unit_price is None:
            raise HTTPException(422, "vendor_id, budget_id and unit_price are required to create an order")
        order = {"vendor_id": body.vendor_id, "budget_id": body.budget_id, "quantity": body.quantity,
                 "unit_price": body.unit_price}
    s = suggestions.accept(db, suggestions.get(db, suggestion_id), actor=user, note=body.note, order=order)
    db.commit()
    return suggestions.suggestion_out(s, staff=True)


@router.post("/suggestions/{suggestion_id}/reject")
def reject(suggestion_id: int, body: RejectIn, db: Session = Depends(get_db),
           user: Patron = Depends(require("suggestions:manage"))):
    s = suggestions.reject(db, suggestions.get(db, suggestion_id), actor=user, reason=body.reason)
    db.commit()
    return suggestions.suggestion_out(s, staff=True)
