"""Staff record tools: duplicate detection (for a stored record or a draft) and a record's change history."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..models import Patron
from ..schemas import StrictModel
from ..services import catalog, record_tools

router = APIRouter(tags=["catalogue"])


class DuplicateCheckIn(StrictModel):
    title: str | None = Field(default=None, max_length=500)
    isbn: str | None = Field(default=None, max_length=20)
    authors: list[str] = Field(default_factory=list, max_length=50)
    exclude_id: int | None = None


@router.get("/biblios/{biblio_id}/duplicates")
def duplicates_of(biblio_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """Records that may duplicate this one (same ISBN, near-identical title, shared author)."""
    b = catalog.get_biblio(db, biblio_id)
    return {"results": record_tools.find_duplicates(db, title=b.title, isbn=b.isbn, authors=b.authors, exclude_id=b.id)}


@router.post("/cataloging/duplicates")
def duplicate_check(body: DuplicateCheckIn, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """Live duplicate check for a record being created or edited (nothing is stored)."""
    return {"results": record_tools.find_duplicates(db, title=body.title, isbn=body.isbn, authors=body.authors,
                                                    exclude_id=body.exclude_id)}


@router.get("/biblios/{biblio_id}/history")
def record_history(biblio_id: int, limit: int = Query(default=100, ge=1, le=500), db: Session = Depends(get_db),
                   _: Patron = Depends(require("catalog:read"))):
    """Change history of a record and its items, newest first (from the audit log, without IP addresses)."""
    catalog.get_biblio(db, biblio_id)
    return {"results": record_tools.history(db, biblio_id, limit=limit)}
