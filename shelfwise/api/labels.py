"""Label layouts, print-job previews and Code 128 barcode rendering."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, require
from ..errors import Conflict
from ..models import LabelLayout, Patron
from ..schemas import StrictModel
from ..security import has_permission
from ..services import audit, barcodes
from ..services import labels as svc

router = APIRouter(tags=["labels"])


class LayoutIn(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(default="any", pattern="^(spine|item|patron|any)$")
    page_size: str = Field(default="A4", pattern="^(A4|Letter|custom)$")
    page_width: float = Field(default=210, gt=0, le=1000)
    page_height: float = Field(default=297, gt=0, le=1000)
    rows: int = Field(ge=1, le=60)
    cols: int = Field(ge=1, le=60)
    margin_top: float = Field(ge=0, le=500)
    margin_left: float = Field(ge=0, le=500)
    gutter_x: float = Field(default=0, ge=0, le=500)
    gutter_y: float = Field(default=0, ge=0, le=500)
    label_width: float = Field(gt=0, le=1000)
    label_height: float = Field(gt=0, le=1000)
    padding: float = Field(default=2, ge=0, le=50)
    font_size: float = Field(default=9, ge=3, le=72)


class JobIn(StrictModel):
    kind: str = Field(default="item", pattern="^(spine|item|patron)$")
    layout_id: int | None = None
    start: int = Field(default=1, ge=1, le=3600)
    copies: int = Field(default=1, ge=1, le=20)
    source: str = Field(default="barcodes", pattern="^(barcodes|recent|biblio|patrons)$")
    barcodes: str | list[str] | None = None
    days: int | None = Field(default=None, ge=1, le=3650)
    branch_id: int | None = None
    biblio_id: int | None = None
    split_decimal: bool = False
    patron_q: str | None = Field(default=None, max_length=120)
    patron_ids: str | list[int] | None = None
    category_id: int | None = None
    new_days: int | None = Field(default=None, ge=1, le=3650)


def require_job_permission(user: Patron, kind: str) -> None:
    needed = "patrons:read" if kind == "patron" else "catalog:read"
    for perm in ("labels", needed):
        if not has_permission(user, perm):
            raise HTTPException(403, f"Missing permission: {perm}")


@router.get("/labels/layouts")
def list_layouts(db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    if svc.ensure_presets(db):
        db.commit()
    rows = db.scalars(select(LabelLayout).order_by(LabelLayout.is_preset.desc(), LabelLayout.kind, LabelLayout.name))
    return {"results": [svc.layout_out(x) for x in rows], "page_sizes": svc.PAGE_SIZES}


@router.post("/labels/layouts", status_code=201)
def create_layout(body: LayoutIn, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("labels"))):
    data = svc.validate_layout(body.model_dump())
    if db.scalar(select(LabelLayout.id).where(LabelLayout.name == data["name"])):
        raise Conflict(f"A layout named “{data['name']}” already exists")
    layout = LabelLayout(**data, is_preset=False)
    db.add(layout)
    db.flush()
    audit.record(db, "create", "label_layout", layout.id, actor=user, ip=client_ip(request), name=layout.name)
    db.commit()
    return svc.layout_out(layout)


@router.put("/labels/layouts/{layout_id}")
def update_layout(layout_id: int, body: LayoutIn, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("labels"))):
    layout = svc.get_layout(db, layout_id)
    if layout.is_preset:
        raise Conflict("Presets cannot be changed — save a copy under a new name instead")
    data = svc.validate_layout(body.model_dump())
    if db.scalar(select(LabelLayout.id).where(LabelLayout.name == data["name"], LabelLayout.id != layout.id)):
        raise Conflict(f"A layout named “{data['name']}” already exists")
    for k, v in data.items():
        setattr(layout, k, v)
    audit.record(db, "update", "label_layout", layout.id, actor=user, ip=client_ip(request), name=layout.name)
    db.commit()
    return svc.layout_out(layout)


@router.delete("/labels/layouts/{layout_id}", status_code=204)
def delete_layout(layout_id: int, request: Request, db: Session = Depends(get_db),
                  user: Patron = Depends(require("labels"))):
    layout = svc.get_layout(db, layout_id)
    if layout.is_preset:
        raise Conflict("Presets cannot be deleted")
    audit.record(db, "delete", "label_layout", layout.id, actor=user, ip=client_ip(request), name=layout.name)
    db.delete(layout)
    db.commit()
    return Response(status_code=204)


@router.post("/labels/preview")
def preview(body: JobIn, db: Session = Depends(get_db), user: Patron = Depends(require("catalog:read"))):
    """What a print job would contain: label count, sheets, blank cells, unknown barcodes."""
    require_job_permission(user, body.kind)
    job = svc.build(db, body.model_dump(exclude_none=True))
    db.commit()  # keeps preset layouts inserted on first use
    return svc.summary(job)


@router.get("/barcodes/code128.svg")
def code128(data: str = Query(min_length=1, max_length=80), text: bool = True,
            _: Patron = Depends(require("catalog:read"))):
    """Render any value as a Code 128 (B/C) barcode in SVG."""
    try:
        svg = barcodes.svg(data, text=text)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "private, max-age=86400"})
