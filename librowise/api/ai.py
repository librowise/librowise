from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ..ai import cataloging, copilot, llm, nlsearch
from ..db import get_db
from ..deps import client_ip, require
from ..models import Patron
from ..schemas import AskIn, CatalogAssistIn
from ..security import ai_limiter
from ..services import settings as settings_svc

router = APIRouter(prefix="/ai", tags=["ai"])


def _limit(request: Request, user: Patron) -> None:
    if not ai_limiter.allow(f"ai:{user.id}:{client_ip(request)}"):
        raise HTTPException(429, "Too many AI requests; please slow down")


@router.get("/status")
def status():
    return {"claude": llm.available(), "engine": "claude" if llm.available() else "local"}


@router.post("/ask")
def ask(body: AskIn, request: Request, db: Session = Depends(get_db), user: Patron = Depends(require("ai:staff"))):
    """Staff copilot: natural-language questions answered from live library data."""
    if not settings_svc.get(db, "ai_assistant_enabled"):
        raise HTTPException(403, "The AI assistant is disabled")
    _limit(request, user)
    history = [m for m in body.history if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)]
    return copilot.ask(db, body.question, history)


@router.post("/catalog-assist")
def catalog_assist(body: CatalogAssistIn, request: Request, db: Session = Depends(get_db),
                   user: Patron = Depends(require("catalog:write"))):
    """Suggest subjects, Dewey classification, audience and summary for a record."""
    _limit(request, user)
    return cataloging.suggest(db, body.model_dump())


@router.get("/parse-query")
def parse_query(request: Request, q: str = Query(min_length=1, max_length=500)):
    """Show how a natural-language query is interpreted (debugging aid for staff and patrons)."""
    if not ai_limiter.allow(f"parse:{client_ip(request)}"):
        raise HTTPException(429, "Too many AI requests; please slow down")
    pq = nlsearch.parse(q)
    return pq.__dict__
