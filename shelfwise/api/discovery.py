"""OPAC discovery: search-as-you-type, spelling suggestions, the virtual shelf and citations."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import biblio_out
from ..services import catalog, citations, discovery

router = APIRouter(tags=["discovery"])


@router.get("/search/suggest")
def suggest(q: str = Query(default="", max_length=100), limit: int = Query(default=8, ge=1, le=12),
            db: Session = Depends(get_db)):
    """Prefix suggestions (titles, authors, subjects) for search-as-you-type."""
    return {"q": q, "suggestions": discovery.suggest(db, q, limit)}


@router.get("/search/did-you-mean")
def did_you_mean(q: str = Query(min_length=1, max_length=200), db: Session = Depends(get_db)):
    """A spelling suggestion built from catalogue vocabulary, returned only if it finds more records."""
    suggestion = discovery.did_you_mean(db, q)
    if not suggestion or suggestion.lower() == q.strip().lower():
        return {"q": q, "suggestion": None, "total": None}
    total = catalog.search(db, suggestion, per_page=1).total
    original = catalog.search(db, q, per_page=1).total
    if total <= original:
        return {"q": q, "suggestion": None, "total": None}
    return {"q": q, "suggestion": suggestion, "total": total}


@router.get("/biblios/{biblio_id}/shelf")
def shelf(biblio_id: int, n: int = Query(default=6, ge=1, le=12), branch_id: int | None = None,
          db: Session = Depends(get_db)):
    """Neighbouring titles by call number — a virtual walk along the shelf."""
    b = catalog.get_biblio(db, biblio_id)
    res = discovery.shelf(db, b, n=n, branch_id=branch_id)
    ids = [bid for bid, _ in res["before"] + res["after"]]
    avail = catalog.availability(db, ids)
    by_id = {x.id: x for x in catalog.load_biblios(db, ids)}

    def side(pairs):
        return [{**biblio_out(by_id[bid], avail.get(bid)), "call_number": cn} for bid, cn in pairs if bid in by_id]

    return {"anchor": res["anchor"], "current": {"id": b.id, "title": b.title}, "before": side(res["before"]), "after": side(res["after"])}


def _record(request: Request, b) -> dict:
    return {"id": b.id, "title": b.title, "subtitle": b.subtitle, "authors": b.authors or [], "publisher": b.publisher,
            "pub_year": b.pub_year, "edition": b.edition, "isbn": b.isbn, "material_type": b.material_type,
            "language": b.language, "subjects": b.subjects or [], "url": f"{str(request.base_url).rstrip('/')}/record/{b.id}"}


@router.get("/biblios/{biblio_id}/cite")
def cite(biblio_id: int, request: Request, style: str = Query(default="all", pattern="^(all|apa|mla|chicago|bibtex|ris)$"),
         download: bool = False, db: Session = Depends(get_db)):
    """Formatted citations. ``style=ris|bibtex&download=true`` returns a file for reference managers."""
    rec = _record(request, catalog.get_biblio(db, biblio_id))
    if download and style in ("ris", "bibtex"):
        body = citations.FORMATTERS[style](rec)
        ext, media = ("ris", "application/x-research-info-systems") if style == "ris" else ("bib", "application/x-bibtex")
        return Response(body, media_type=f"{media}; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{citations.bibtex_key(rec)}.{ext}"'})
    styles = citations.STYLES if style == "all" else (style,)
    return {"id": biblio_id, "citations": [citations.cite(rec, s) for s in styles]}
