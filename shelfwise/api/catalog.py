from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..ai import cataloging, recommend, semantic
from ..ai.nlsearch import smart_search
from ..db import get_db
from ..deps import client_ip, optional_user, require
from ..errors import NotFound
from ..models import Branch, Item, ItemType, Patron, Review
from ..schemas import BiblioIn, BiblioPatch, ItemIn, ItemPatch, biblio_out, item_out
from ..security import ai_limiter, has_permission
from ..services import audit, catalog, marc
from ..services import settings as settings_svc

router = APIRouter(tags=["catalogue"])


def _results(db: Session, ids: list[int]) -> list[dict]:
    avail = catalog.availability(db, ids)
    return [biblio_out(b, avail.get(b.id)) for b in catalog.load_biblios(db, ids)]


@router.get("/search")
def search(
    q: str | None = Query(default=None, max_length=500),
    material_type: str | None = None,
    language: str | None = None,
    subject: str | None = None,
    author: str | None = None,
    audience: str | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    branch_id: int | None = None,
    available_only: bool = False,
    sort: str = Query(default="relevance", pattern="^(relevance|title|year_desc|year_asc|newest)$"),
    page: int = Query(default=1, ge=1, le=10000),
    per_page: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Keyword search with filters and facets (BM25-ranked)."""
    f = catalog.SearchFilters(material_type=material_type, language=language, subject=subject,
                              author=author, audience=audience, year_from=year_from, year_to=year_to,
                              branch_id=branch_id, available_only=available_only)
    res = catalog.search(db, q, f, page=page, per_page=per_page, sort=sort if q else (sort if sort != "relevance" else "newest"))
    return {"total": res.total, "page": page, "per_page": per_page, "took_ms": res.took_ms,
            "facets": res.facets, "results": _results(db, res.ids)}


@router.get("/search/smart")
def smart(request: Request, q: str = Query(min_length=1, max_length=500),
          page: int = Query(default=1, ge=1), per_page: int = Query(default=20, ge=1, le=100),
          db: Session = Depends(get_db)):
    """AI search: understands natural language and blends keyword + semantic ranking."""
    if not settings_svc.get(db, "ai_opac_enabled"):
        raise HTTPException(403, "AI search is disabled")
    if not ai_limiter.allow(f"smart:{client_ip(request)}"):
        raise HTTPException(429, "Too many AI requests; please slow down")
    res = smart_search(db, q, page=page, per_page=per_page)
    return {"total": res["total"], "page": page, "parsed": res["parsed"], "facets": res["facets"],
            "results": _results(db, res["ids"])}


@router.get("/biblios/{biblio_id}")
def get_biblio(biblio_id: int, db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    b = catalog.get_biblio(db, biblio_id)
    avail = catalog.availability(db, [b.id])[b.id]
    out = biblio_out(b, avail, full=True)
    staff = has_permission(user, "catalog:read")
    out["items"] = [item_out(i) for i in b.items if i.deleted_at is None and (staff or i.status.value != "withdrawn")]
    reviews = db.scalars(select(Review).where(Review.biblio_id == b.id, Review.approved.is_(True))
                         .order_by(Review.created_at.desc()).limit(20)).all()
    out["rating"] = {
        "average": round(sum(r.rating for r in reviews) / len(reviews), 2) if reviews else None,
        "count": len(reviews),
    }
    out["reviews"] = [{"id": r.id, "rating": r.rating, "body": r.body, "by": r.patron.first_name,
                       "created_at": r.created_at} for r in reviews]
    from ..models import Hold, HoldStatus
    out["holds_queued"] = db.scalar(select(func.count()).select_from(Hold).where(
        Hold.biblio_id == b.id, Hold.status == HoldStatus.queued))
    return out


@router.get("/biblios/{biblio_id}/related")
def related(biblio_id: int, db: Session = Depends(get_db)):
    catalog.get_biblio(db, biblio_id)
    rec = recommend.for_biblio(db, biblio_id)
    return {"results": _results(db, rec["ids"]), "signals": {k: rec[k] for k in ("collaborative", "content")}}


@router.post("/biblios", status_code=201)
def create_biblio(body: BiblioIn, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("catalog:write"))):
    b = catalog.create_biblio(db, body.model_dump())
    audit.record(db, "create", "biblio", b.id, actor=user, ip=client_ip(request), title=b.title)
    db.commit()
    semantic.index.invalidate()
    return biblio_out(b, full=True)


@router.patch("/biblios/{biblio_id}")
def update_biblio(biblio_id: int, body: BiblioPatch, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("catalog:write"))):
    b = catalog.get_biblio(db, biblio_id)
    changes = body.model_dump(exclude_unset=True)
    catalog.update_biblio(db, b, changes)
    audit.record(db, "update", "biblio", b.id, actor=user, ip=client_ip(request), fields=sorted(changes))
    db.commit()
    return biblio_out(b, full=True)


@router.delete("/biblios/{biblio_id}", status_code=204)
def delete_biblio(biblio_id: int, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("catalog:delete"))):
    b = catalog.get_biblio(db, biblio_id)
    catalog.delete_biblio(db, b)
    audit.record(db, "delete", "biblio", b.id, actor=user, ip=client_ip(request), title=b.title)
    db.commit()
    return Response(status_code=204)


# ------------------------------------------------------------------ items


@router.post("/biblios/{biblio_id}/items", status_code=201)
def add_item(biblio_id: int, body: ItemIn, db: Session = Depends(get_db),
             user: Patron = Depends(require("catalog:write"))):
    b = catalog.get_biblio(db, biblio_id)
    if not db.get(Branch, body.branch_id) or not db.get(ItemType, body.item_type_id):
        raise HTTPException(422, "Unknown branch or item type")
    item = catalog.create_item(db, b, body.model_dump())
    audit.record(db, "create", "item", item.id, actor=user, barcode=item.barcode)
    db.commit()
    return item_out(item)


@router.get("/items/{barcode}")
def get_item(barcode: str, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    return item_out(catalog.item_by_barcode(db, barcode), with_biblio=True)


@router.patch("/items/{item_id}")
def update_item(item_id: int, body: ItemPatch, db: Session = Depends(get_db),
                user: Patron = Depends(require("catalog:write"))):
    item = db.get(Item, item_id)
    if item is None or item.deleted_at is not None:
        raise NotFound("Item not found")
    from ..models import ItemStatus
    data = body.model_dump(exclude_unset=True)
    if "status" in data:
        if item.status == ItemStatus.on_loan:
            raise HTTPException(409, "Check the item in before changing its status")
        data["status"] = ItemStatus(data["status"])
    for k, v in data.items():
        setattr(item, k, v)
    audit.record(db, "update", "item", item.id, actor=user, fields=sorted(data))
    db.commit()
    return item_out(item)


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("catalog:delete"))):
    from ..models import ItemStatus, utcnow
    item = db.get(Item, item_id)
    if item is None or item.deleted_at is not None:
        raise NotFound("Item not found")
    if item.status == ItemStatus.on_loan:
        raise HTTPException(409, "Item is on loan")
    item.deleted_at = utcnow()
    audit.record(db, "delete", "item", item.id, actor=user, barcode=item.barcode)
    db.commit()
    return Response(status_code=204)


# ------------------------------------------------------------------ cataloguing tools


@router.get("/cataloging/isbn/{isbn}")
def isbn_lookup(isbn: str, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:write"))):
    norm = catalog.normalize_isbn(isbn)
    if not norm:
        raise HTTPException(422, "Invalid ISBN checksum")
    existing = db.scalar(select(catalog.Biblio.id).where(catalog.Biblio.isbn == norm,
                                                         catalog.Biblio.deleted_at.is_(None)))
    data = cataloging.lookup_isbn(norm)
    return {"isbn": norm, "existing_biblio_id": existing, "found": bool(data), "record": data}


@router.post("/cataloging/import")
async def import_marc(file: UploadFile = File(...), branch_id: int = Query(...), item_type_id: int = Query(...),
                      db: Session = Depends(get_db), user: Patron = Depends(require("catalog:write"))):
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (50 MB max)")
    stats = marc.import_marc(db, data, default_branch_id=branch_id, default_item_type_id=item_type_id)
    audit.record(db, "marc_import", "biblio", None, actor=user, filename=file.filename,
                 created=stats["created"], items=stats["items"])
    db.commit()
    semantic.index.invalidate()
    return stats


@router.get("/cataloging/export")
def export_marc(fmt: str = Query(default="xml", pattern="^(xml|mrc)$"), ids: str | None = None,
                db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()][:5000]
        biblios = catalog.load_biblios(db, id_list)
    else:
        biblios = list(db.scalars(select(catalog.Biblio).where(catalog.Biblio.deleted_at.is_(None)).limit(50000)))
    payload = marc.export(db, biblios, fmt)
    media = "application/marcxml+xml" if fmt == "xml" else "application/marc"
    return Response(payload, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="shelfwise-export.{fmt}"'})


@router.get("/lookups")
def lookups(db: Session = Depends(get_db), user: Patron | None = Depends(optional_user)):
    from ..models import PatronCategory
    out = {"branches": [{"id": b.id, "code": b.code, "name": b.name} for b in db.scalars(select(Branch).order_by(Branch.name))]}
    if has_permission(user, "catalog:read"):
        out["item_types"] = [{"id": t.id, "code": t.code, "name": t.name} for t in db.scalars(select(ItemType).order_by(ItemType.name))]
        out["categories"] = [{"id": c.id, "code": c.code, "name": c.name} for c in db.scalars(select(PatronCategory).order_by(PatronCategory.name))]
    out["material_types"] = ["book", "ebook", "audiobook", "dvd", "serial", "comic"]
    return out
