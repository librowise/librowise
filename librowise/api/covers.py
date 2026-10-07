"""Cover uploads for catalogue records (the public image route is ``GET /covers/{id}.jpg`` in web.py)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import client_ip, require
from ..errors import NotFound
from ..models import Biblio, Patron
from ..services import audit
from ..services import covers as svc

router = APIRouter(tags=["catalog"])


def _biblio(db: Session, biblio_id: int) -> Biblio:
    b = db.get(Biblio, biblio_id)
    if b is None or b.deleted_at is not None:
        raise NotFound("Record not found")
    return b


@router.post("/biblios/{biblio_id}/cover", status_code=201)
async def upload_cover(biblio_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                       user: Patron = Depends(require("catalog:write"))):
    """Upload or replace a record's cover (JPEG, PNG, WebP or GIF; verified by content, not by name)."""
    b = _biblio(db, biblio_id)
    limit = get_settings().cover_upload_max_bytes
    data = await file.read(limit + 1)
    try:
        img = svc.save_upload(b.id, data)
    except svc.CoverError as exc:
        raise HTTPException(422, str(exc))
    audit.record(db, "cover_upload", "biblio", b.id, actor=user, ip=client_ip(request),
                 type=img.kind, width=img.width, height=img.height, bytes=len(data))
    db.commit()
    return {"cover": svc.cover_src(b), "type": img.content_type, "width": img.width, "height": img.height}


@router.delete("/biblios/{biblio_id}/cover", status_code=204)
def delete_cover(biblio_id: int, request: Request, db: Session = Depends(get_db),
                 user: Patron = Depends(require("catalog:write"))):
    b = _biblio(db, biblio_id)
    if not svc.remove_upload(b.id):
        raise NotFound("This record has no uploaded cover")
    audit.record(db, "cover_delete", "biblio", b.id, actor=user, ip=client_ip(request))
    db.commit()
    return Response(status_code=204)
