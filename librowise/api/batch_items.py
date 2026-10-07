"""Batch item modification/withdrawal/deletion and inventory (stocktake)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import client_ip, require
from ..models import Patron
from ..schemas import StrictModel
from ..services import audit
from ..services import batch_items as svc

router = APIRouter(tags=["batch items"])

_STATUS = "^(available|on_loan|on_hold_shelf|in_transit|processing|lost|damaged|withdrawn)$"


class ItemSearchIn(StrictModel):
    q: str | None = Field(default=None, max_length=500)
    material_type: str | None = Field(default=None, max_length=32)
    branch_id: int | None = None
    item_type_id: int | None = None
    status: str | None = Field(default=None, pattern=_STATUS)
    shelf_location: str | None = Field(default=None, max_length=64)
    call_number_prefix: str | None = Field(default=None, max_length=64)


class SelectionIn(StrictModel):
    barcodes: str | list[str] | None = Field(default=None, description="Newline/comma separated or a list")
    search: ItemSearchIn | None = None


class ChangesIn(StrictModel):
    branch_id: int | None = None
    item_type_id: int | None = None
    shelf_location: str | None = Field(default=None, max_length=64, description='"" or null clears it')
    status: str | None = Field(default=None, pattern="^(available|processing|lost|damaged|withdrawn)$")
    notes: str | None = Field(default=None, max_length=2000)
    notes_mode: str | None = Field(default=None, pattern="^(replace|append|clear)$")
    call_number_prefix: str | None = Field(default=None, max_length=16)
    call_number_prefix_mode: str | None = Field(default=None, pattern="^(add|remove)$")


class ModifyIn(StrictModel):
    selection: SelectionIn
    changes: ChangesIn
    dry_run: bool = True


class DeleteIn(StrictModel):
    selection: SelectionIn
    action: str = Field(default="withdraw", pattern="^(withdraw|delete)$")
    delete_empty_biblios: bool = False
    dry_run: bool = True


class InventoryIn(StrictModel):
    branch_id: int
    shelf_location: str | None = Field(default=None, max_length=64, description='"(none)" = items without a location')
    call_number_from: str | None = Field(default=None, max_length=64)
    call_number_to: str | None = Field(default=None, max_length=64)
    item_type_id: int | None = None
    barcodes: str | list[str] = Field(description="Scanned barcodes, newline/comma separated or a list")
    mark_seen: bool = True


def _selection(body: SelectionIn) -> dict:
    return {"barcodes": body.barcodes, "search": body.search.model_dump(exclude_none=True) if body.search else None}


@router.post("/batch/items/modify")
def batch_modify(body: ModifyIn, request: Request, db: Session = Depends(get_db),
                 user: Patron = Depends(require("items:batch"))):
    """Preview (``dry_run``) or apply the same changes to many items, with a per-item result."""
    items, unknown = svc.select_items(db, _selection(body.selection))
    changes = body.changes.model_dump(exclude_unset=True)
    if body.dry_run:
        rows = svc.plan_modify(db, items, changes)
        db.rollback()
    else:
        rows = svc.apply_modify(db, items, changes)
        changed = [r["item_id"] for r in rows if r["result"] == "changed"]
        audit.record(db, "batch_modify", "item", None, actor=user, ip=client_ip(request),
                     changes=sorted(k for k in changes if k not in ("notes_mode", "call_number_prefix_mode")),
                     count=len(changed), item_ids=changed[:1000])
        db.commit()
    return {"dry_run": body.dry_run, "summary": svc.tally(rows), "unknown": unknown, "results": svc.public_rows(rows)}


@router.post("/batch/items/delete")
def batch_delete(body: DeleteIn, request: Request, db: Session = Depends(get_db),
                 user: Patron = Depends(require("items:batch"))):
    """Withdraw or delete many items. Items on loan, in transit or on the hold shelf are protected."""
    items, unknown = svc.select_items(db, _selection(body.selection))
    if body.dry_run:
        rows = svc.plan_delete(db, items, body.action)
        db.rollback()
        return {"dry_run": True, "summary": svc.tally(rows), "unknown": unknown, "results": rows, "biblios_deleted": []}
    res = svc.apply_delete(db, items, body.action, delete_empty_biblios=body.delete_empty_biblios)
    done = [r["item_id"] for r in res["rows"] if r["result"] in ("withdrawn", "deleted")]
    audit.record(db, f"batch_{body.action}", "item", None, actor=user, ip=client_ip(request), count=len(done),
                 item_ids=done[:1000], biblios_deleted=[b["biblio_id"] for b in res["biblios_deleted"]] or None)
    db.commit()
    return {"dry_run": False, "summary": svc.tally(res["rows"]), "unknown": unknown, "results": res["rows"],
            "biblios_deleted": res["biblios_deleted"]}


@router.get("/inventory/locations")
def locations(branch_id: int | None = None, db: Session = Depends(get_db),
              _: Patron = Depends(require("catalog:read"))):
    """Shelf locations in use (with item counts), optionally for one branch."""
    return {"results": svc.shelf_locations(db, branch_id)}


@router.post("/inventory")
def inventory(body: InventoryIn, request: Request, fmt: str = Query(default="json", alias="format", pattern="^(json|csv)$"),
              db: Session = Depends(get_db), user: Patron = Depends(require("inventory"))):
    """Stocktake: marks scanned items as seen and reports missing, out-of-place and wrong-status items."""
    report = svc.run_inventory(db, branch_id=body.branch_id, barcodes=body.barcodes, shelf_location=body.shelf_location,
                               call_number_from=body.call_number_from, call_number_to=body.call_number_to,
                               item_type_id=body.item_type_id, mark_seen=body.mark_seen)
    if body.mark_seen:
        audit.record(db, "inventory", "item", None, actor=user, ip=client_ip(request), branch_id=body.branch_id,
                     shelf_location=body.shelf_location, **{k: report["summary"][k] for k in ("unique", "missing", "unknown")})
        db.commit()
    else:
        db.rollback()
    if fmt == "csv":
        return Response(svc.inventory_csv(report), media_type="text/csv",
                        headers={"Content-Disposition": 'attachment; filename="inventory.csv"'})
    return report
