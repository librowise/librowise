"""MARC editor API: load a record as an editable grid, convert between views, preview and save."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..ai import semantic
from ..db import get_db
from ..deps import client_ip, require
from ..errors import Conflict
from ..models import Patron
from ..schemas import biblio_out
from ..services import audit, catalog
from ..services import marc_dictionary as dictionary
from ..services import marc_editor as editor

router = APIRouter(tags=["marc editor"])


class _Raw(BaseModel):
    # No whitespace stripping: blanks are significant in indicators, 008 and subfield data.
    model_config = ConfigDict(extra="forbid")


class SubfieldIn(_Raw):
    code: str = Field(max_length=4)
    value: str = Field(default="", max_length=20000)


class FieldIn(_Raw):
    tag: str = Field(max_length=4)
    ind1: str | None = Field(default=None, max_length=2)
    ind2: str | None = Field(default=None, max_length=2)
    value: str | None = Field(default=None, max_length=20000)
    subfields: list[SubfieldIn] | None = Field(default=None, max_length=1000)


class GridIn(_Raw):
    leader: str = Field(default="", max_length=40)
    fields: list[FieldIn] = Field(default_factory=list, max_length=5000)


class ConvertIn(_Raw):
    source: str = Field(alias="from", pattern="^(grid|mnemonic|xml)$")
    target: str = Field(alias="to", pattern="^(grid|mnemonic|xml)$")
    grid: GridIn | None = None
    text: str | None = Field(default=None, max_length=2_000_000)


class SaveIn(_Raw):
    grid: GridIn
    expected_updated_at: datetime | None = None


def _grid(g: GridIn) -> dict:
    return g.model_dump(exclude_none=True)


@router.get("/marc/dictionary")
def marc_dictionary(_: Patron = Depends(require("catalog:read"))):
    """MARC21 bibliographic field labels, help, repeatability and subfield names for editor hints."""
    return {"fields": dictionary.as_json()}


@router.post("/marc/convert")
def convert(body: ConvertIn, _: Patron = Depends(require("catalog:read"))):
    """Convert a record between the grid model, MarcEdit mnemonic text and MARCXML."""
    res = editor.convert(_grid(body.grid) if body.grid else None, body.text, body.source, body.target)
    errors, warnings = editor.validate(res["grid"])
    return {**res, "validation": {"errors": errors, "warnings": warnings}}


@router.post("/marc/validate")
def validate(body: GridIn, _: Patron = Depends(require("catalog:read"))):
    errors, warnings = editor.validate(editor.normalize_grid(_grid(body)))
    return {"valid": not errors, "errors": errors, "warnings": warnings}


@router.get("/biblios/{biblio_id}/marc")
def load(biblio_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
    """The record as an editable grid (generated from the bibliographic fields if no MARC is stored)."""
    return editor.editor_payload(catalog.get_biblio(db, biblio_id))


@router.post("/biblios/{biblio_id}/marc/preview")
def preview(biblio_id: int, body: GridIn, db: Session = Depends(get_db),
            _: Patron = Depends(require("catalog:write"))):
    """Validation plus a line diff and the bibliographic field changes a save would make."""
    return editor.preview(catalog.get_biblio(db, biblio_id), _grid(body))


@router.put("/biblios/{biblio_id}/marc")
def save(biblio_id: int, body: SaveIn, request: Request, db: Session = Depends(get_db),
         user: Patron = Depends(require("catalog:write"))):
    b = catalog.get_biblio(db, biblio_id)
    if body.expected_updated_at and abs((b.updated_at - body.expected_updated_at.replace(tzinfo=None)).total_seconds()) > 0.001:
        raise Conflict("This record was changed by someone else since you opened it. Reload to see their changes.",
                       code="stale_record")
    result = editor.save(db, b, _grid(body.grid))
    audit.record(db, "marc_edit", "biblio", b.id, actor=user, ip=client_ip(request), fields=result["changed_fields"])
    db.commit()
    semantic.index.invalidate()
    return {**result, "biblio": biblio_out(b, full=True)}
