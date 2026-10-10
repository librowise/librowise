"""Acquisitions: vendors, budgets and purchase orders.

Order lifecycle: ``draft`` → ``ordered`` → ``received`` (or ``cancelled`` from draft/ordered). Drafts are
created from the staff UI ("Save as draft") or by accepting a patron purchase suggestion with an order; they
count against the budget (as *planned* spend) so the remaining balance is never overstated, but they are
only sent to the vendor when placed (``POST /orders/{id}/place``). Drafts can be edited freely; placed
orders keep their price and quantity (only the notes can change).
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..ai import insights
from ..db import get_db
from ..deps import require
from ..errors import Conflict, NotFound
from ..models import Budget, OrderStatus, Patron, PurchaseOrder, PurchaseSuggestion, Vendor, utcnow
from ..schemas import BudgetIn, OrderIn, ReceiveIn, StrictModel, VendorIn, money
from ..services import audit, catalog

router = APIRouter(prefix="/acquisitions", tags=["acquisitions"])


class OrderCreateIn(OrderIn):
    status: Literal["draft", "ordered"] = "ordered"


class OrderPatch(StrictModel):
    vendor_id: int | None = None
    budget_id: int | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    isbn: str | None = Field(default=None, max_length=20)
    quantity: int | None = Field(default=None, ge=1, le=1000)
    unit_price: int | None = Field(default=None, ge=0, description="Minor units (paise/cents)")
    notes: str | None = Field(default=None, max_length=255)


class VendorPatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    email: str | None = None
    phone: str | None = None
    discount_pct: float | None = Field(default=None, ge=0, le=100)


class BudgetPatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    fiscal_year: int | None = Field(default=None, ge=2000, le=2100)
    allocated: int | None = Field(default=None, ge=0)
    branch_id: int | None = None


def _vendor_out(v: Vendor, counts: dict[int, int] | None = None) -> dict:
    return {"id": v.id, "name": v.name, "email": v.email, "phone": v.phone, "discount_pct": v.discount_pct,
            "orders": (counts or {}).get(v.id, 0)}


@router.get("/vendors")
def vendors(db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    counts = dict(db.execute(select(PurchaseOrder.vendor_id, func.count()).group_by(PurchaseOrder.vendor_id)).all())
    return {"results": [_vendor_out(v, counts) for v in db.scalars(select(Vendor).order_by(Vendor.name))]}


@router.post("/vendors", status_code=201)
def create_vendor(body: VendorIn, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    if db.scalar(select(Vendor.id).where(Vendor.name == body.name)):
        raise HTTPException(409, "Vendor already exists")
    v = Vendor(**body.model_dump())
    db.add(v)
    db.flush()
    audit.record(db, "create", "vendor", v.id, actor=user)
    db.commit()
    return {"id": v.id, "name": v.name}


@router.patch("/vendors/{vendor_id}")
def update_vendor(vendor_id: int, body: VendorPatch, db: Session = Depends(get_db),
                  user: Patron = Depends(require("acquisitions:write"))):
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise NotFound("Vendor not found")
    data = body.model_dump(exclude_unset=True)
    if data.get("name") and data["name"] != v.name and db.scalar(select(Vendor.id).where(Vendor.name == data["name"])):
        raise HTTPException(409, "Vendor already exists")
    for k, val in data.items():
        if k == "name" and not val:
            continue
        setattr(v, k, val)
    audit.record(db, "update", "vendor", v.id, actor=user, fields=sorted(data))
    db.commit()
    return _vendor_out(v)


def _spent(db: Session, budget_id: int) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(PurchaseOrder.unit_price * PurchaseOrder.quantity), 0)).where(
        PurchaseOrder.budget_id == budget_id, PurchaseOrder.status != OrderStatus.cancelled)) or 0)


def _by_status(db: Session) -> dict[tuple[int, str], int]:
    rows = db.execute(select(PurchaseOrder.budget_id, PurchaseOrder.status,
                             func.coalesce(func.sum(PurchaseOrder.unit_price * PurchaseOrder.quantity), 0))
                      .group_by(PurchaseOrder.budget_id, PurchaseOrder.status)).all()
    return {(bid, st.value if hasattr(st, "value") else str(st)): int(total or 0) for bid, st, total in rows}


def _budget_out(b: Budget, sums: dict[tuple[int, str], int]) -> dict:
    received, ordered, draft = (sums.get((b.id, s), 0) for s in ("received", "ordered", "draft"))
    spent = received + ordered + draft
    return {"id": b.id, "name": b.name, "fiscal_year": b.fiscal_year, "branch_id": b.branch_id, "allocated": money(b.allocated),
            "committed": money(spent), "remaining": money(b.allocated - spent),
            "used_pct": round(100 * spent / b.allocated, 1) if b.allocated else 0,
            # breakdown of what is committed: received (spent), ordered (encumbered), draft (planned)
            "received": money(received), "ordered": money(ordered), "draft": money(draft)}


@router.get("/budgets")
def budgets(db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    sums = _by_status(db)
    return {"results": [_budget_out(b, sums) for b in db.scalars(select(Budget).order_by(Budget.fiscal_year.desc(), Budget.name))]}


@router.post("/budgets", status_code=201)
def create_budget(body: BudgetIn, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    b = Budget(**body.model_dump())
    db.add(b)
    db.flush()
    audit.record(db, "create", "budget", b.id, actor=user)
    db.commit()
    return {"id": b.id}


@router.patch("/budgets/{budget_id}")
def update_budget(budget_id: int, body: BudgetPatch, db: Session = Depends(get_db),
                  user: Patron = Depends(require("acquisitions:write"))):
    b = db.get(Budget, budget_id)
    if b is None:
        raise NotFound("Budget not found")
    data = body.model_dump(exclude_unset=True)
    if "allocated" in data and data["allocated"] is not None and data["allocated"] < _spent(db, b.id):
        raise Conflict(f"The allocation cannot be lower than what is already committed ({money(_spent(db, b.id)):.2f})")
    for k, val in data.items():
        if k in ("name", "fiscal_year", "allocated") and val is None:
            continue
        setattr(b, k, val)
    audit.record(db, "update", "budget", b.id, actor=user, fields=sorted(data))
    db.commit()
    return _budget_out(b, _by_status(db))


def _suggestions_for(db: Session, order_ids: list[int]) -> dict[int, int]:
    if not order_ids:
        return {}
    return dict(db.execute(select(PurchaseSuggestion.order_id, PurchaseSuggestion.id)
                           .where(PurchaseSuggestion.order_id.in_(order_ids))).all())


def _order_out(o: PurchaseOrder, suggestion_id: int | None = None) -> dict:
    return {"id": o.id, "title": o.title, "isbn": o.isbn, "quantity": o.quantity, "unit_price": money(o.unit_price),
            "total": money(o.unit_price * o.quantity), "status": o.status.value, "vendor": o.vendor.name,
            "budget": o.budget.name, "biblio_id": o.biblio_id, "created_at": o.created_at, "received_at": o.received_at,
            "vendor_id": o.vendor_id, "budget_id": o.budget_id, "fiscal_year": o.budget.fiscal_year, "notes": o.notes,
            "updated_at": o.updated_at, "suggestion_id": suggestion_id}


def _get_order(db: Session, order_id: int) -> PurchaseOrder:
    o = db.get(PurchaseOrder, order_id)
    if o is None:
        raise NotFound("Order not found")
    return o


def _check_budget(db: Session, budget: Budget, extra: int) -> None:
    if _spent(db, budget.id) + extra > budget.allocated:
        raise Conflict(f"Order exceeds remaining budget ({money(budget.allocated - _spent(db, budget.id)):.2f})")


@router.get("/orders")
def orders(status: str | None = None, db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    stmt = select(PurchaseOrder).order_by(PurchaseOrder.created_at.desc())
    if status:
        stmt = stmt.where(PurchaseOrder.status == OrderStatus(status))
    rows = list(db.scalars(stmt.limit(500)))
    sugg = _suggestions_for(db, [o.id for o in rows])
    counts = {s.value: n for s, n in db.execute(select(PurchaseOrder.status, func.count()).group_by(PurchaseOrder.status)).all()}
    return {"results": [_order_out(o, sugg.get(o.id)) for o in rows], "counts": counts}


@router.post("/orders", status_code=201)
def create_order(body: OrderCreateIn, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    budget = db.get(Budget, body.budget_id)
    if budget is None or db.get(Vendor, body.vendor_id) is None:
        raise NotFound("Unknown vendor or budget")
    cost = body.unit_price * body.quantity
    _check_budget(db, budget, cost)
    data = body.model_dump()
    data["status"] = OrderStatus(data["status"])
    o = PurchaseOrder(**data)
    o.isbn = catalog.normalize_isbn(o.isbn) or o.isbn
    db.add(o)
    db.flush()
    audit.record(db, "create", "order", o.id, actor=user, total=cost, draft=True if o.status == OrderStatus.draft else None)
    db.commit()
    return _order_out(o)


@router.patch("/orders/{order_id}")
def update_order(order_id: int, body: OrderPatch, db: Session = Depends(get_db),
                 user: Patron = Depends(require("acquisitions:write"))):
    """Edit a draft order (anything) or a placed order (notes only)."""
    o = _get_order(db, order_id)
    data = body.model_dump(exclude_unset=True)
    if o.status != OrderStatus.draft and set(data) - {"notes"}:
        raise Conflict(f"Order is {o.status.value}; only drafts can be changed")
    if o.status in (OrderStatus.received, OrderStatus.cancelled) and data:
        raise Conflict(f"Order is {o.status.value}")
    if "vendor_id" in data and (data["vendor_id"] is None or db.get(Vendor, data["vendor_id"]) is None):
        raise NotFound("Unknown vendor")
    budget = o.budget
    if "budget_id" in data:
        budget = db.get(Budget, data["budget_id"]) if data["budget_id"] is not None else None
        if budget is None:
            raise NotFound("Unknown budget")
    qty = data.get("quantity") or o.quantity
    price = data["unit_price"] if data.get("unit_price") is not None else o.unit_price
    if o.status == OrderStatus.draft:
        # Re-check the budget without counting this order's own current total.
        own = o.unit_price * o.quantity if budget.id == o.budget_id else 0
        if _spent(db, budget.id) - own + qty * price > budget.allocated:
            raise Conflict(f"Order exceeds remaining budget ({money(budget.allocated - _spent(db, budget.id) + own):.2f})")
    for k, val in data.items():
        if k in ("title", "quantity", "unit_price") and val is None:
            continue
        setattr(o, k, val)
    if "isbn" in data:
        o.isbn = catalog.normalize_isbn(o.isbn) or (o.isbn or None)
    o.updated_at = utcnow()
    audit.record(db, "update", "order", o.id, actor=user, fields=sorted(data))
    db.commit()
    db.refresh(o)
    return _order_out(o, _suggestions_for(db, [o.id]).get(o.id))


@router.post("/orders/{order_id}/place")
def place(order_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    """Place a draft order with the vendor (draft → ordered)."""
    o = _get_order(db, order_id)
    if o.status != OrderStatus.draft:
        raise Conflict(f"Order is {o.status.value}; only drafts can be placed")
    if _spent(db, o.budget_id) > o.budget.allocated:
        raise Conflict("The budget is overspent; reduce the order or raise the allocation first")
    o.status = OrderStatus.ordered
    o.updated_at = utcnow()
    audit.record(db, "place", "order", o.id, actor=user, total=o.unit_price * o.quantity)
    db.commit()
    return _order_out(o, _suggestions_for(db, [o.id]).get(o.id))


@router.post("/orders/{order_id}/receive")
def receive(order_id: int, body: ReceiveIn, db: Session = Depends(get_db),
            user: Patron = Depends(require("acquisitions:write"))):
    """Receive an order: creates (or reuses) the bibliographic record and one item per copy."""
    o = _get_order(db, order_id)
    if o.status != OrderStatus.ordered:
        raise Conflict(f"Order is {o.status.value}")
    biblio = catalog.get_biblio(db, o.biblio_id) if o.biblio_id else None
    if biblio is None and o.isbn:
        bid = db.scalar(select(catalog.Biblio.id).where(catalog.Biblio.isbn == o.isbn, catalog.Biblio.deleted_at.is_(None)))
        biblio = db.get(catalog.Biblio, bid) if bid else None
    if biblio is None:
        biblio = catalog.create_biblio(db, {"title": o.title, "isbn": o.isbn})
    items = [catalog.create_item(db, biblio, {"branch_id": body.branch_id, "item_type_id": body.item_type_id,
                                              "price": o.unit_price, "acquired_on": utcnow().date()})
             for _ in range(o.quantity)]
    o.biblio_id = biblio.id
    o.status = OrderStatus.received
    o.received_at = utcnow()
    audit.record(db, "receive", "order", o.id, actor=user, items=len(items))
    db.commit()
    return {"order": _order_out(o), "biblio_id": biblio.id, "barcodes": [i.barcode for i in items]}


@router.post("/orders/{order_id}/cancel")
def cancel(order_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    o = _get_order(db, order_id)
    if o.status == OrderStatus.received:
        raise Conflict("Received orders cannot be cancelled")
    o.status = OrderStatus.cancelled
    audit.record(db, "cancel", "order", o.id, actor=user)
    db.commit()
    return _order_out(o)


@router.get("/suggestions")
def suggestions(db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    """AI demand signal: titles whose hold queues outstrip copies."""
    return {"results": insights.purchase_suggestions(db)}
