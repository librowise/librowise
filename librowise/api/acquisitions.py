from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..ai import insights
from ..db import get_db
from ..deps import require
from ..errors import Conflict, NotFound
from ..models import Budget, OrderStatus, Patron, PurchaseOrder, Vendor, utcnow
from ..schemas import BudgetIn, OrderIn, ReceiveIn, VendorIn, money
from ..services import audit, catalog

router = APIRouter(prefix="/acquisitions", tags=["acquisitions"])


@router.get("/vendors")
def vendors(db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    return {"results": [{"id": v.id, "name": v.name, "email": v.email, "phone": v.phone, "discount_pct": v.discount_pct}
                        for v in db.scalars(select(Vendor).order_by(Vendor.name))]}


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


def _spent(db: Session, budget_id: int) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(PurchaseOrder.unit_price * PurchaseOrder.quantity), 0)).where(
        PurchaseOrder.budget_id == budget_id, PurchaseOrder.status != OrderStatus.cancelled)) or 0)


@router.get("/budgets")
def budgets(db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    out = []
    for b in db.scalars(select(Budget).order_by(Budget.fiscal_year.desc(), Budget.name)):
        spent = _spent(db, b.id)
        out.append({"id": b.id, "name": b.name, "fiscal_year": b.fiscal_year, "branch_id": b.branch_id, "allocated": money(b.allocated),
                    "committed": money(spent), "remaining": money(b.allocated - spent),
                    "used_pct": round(100 * spent / b.allocated, 1) if b.allocated else 0})
    return {"results": out}


@router.post("/budgets", status_code=201)
def create_budget(body: BudgetIn, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    b = Budget(**body.model_dump())
    db.add(b)
    db.flush()
    audit.record(db, "create", "budget", b.id, actor=user)
    db.commit()
    return {"id": b.id}


def _order_out(o: PurchaseOrder) -> dict:
    return {"id": o.id, "title": o.title, "isbn": o.isbn, "quantity": o.quantity, "unit_price": money(o.unit_price),
            "total": money(o.unit_price * o.quantity), "status": o.status.value, "vendor": o.vendor.name,
            "budget": o.budget.name, "biblio_id": o.biblio_id, "created_at": o.created_at, "received_at": o.received_at}


@router.get("/orders")
def orders(status: str | None = None, db: Session = Depends(get_db), _: Patron = Depends(require("acquisitions:read"))):
    stmt = select(PurchaseOrder).order_by(PurchaseOrder.created_at.desc())
    if status:
        stmt = stmt.where(PurchaseOrder.status == OrderStatus(status))
    return {"results": [_order_out(o) for o in db.scalars(stmt.limit(500))]}


@router.post("/orders", status_code=201)
def create_order(body: OrderIn, db: Session = Depends(get_db), user: Patron = Depends(require("acquisitions:write"))):
    budget = db.get(Budget, body.budget_id)
    if budget is None or db.get(Vendor, body.vendor_id) is None:
        raise NotFound("Unknown vendor or budget")
    cost = body.unit_price * body.quantity
    if _spent(db, budget.id) + cost > budget.allocated:
        raise Conflict(f"Order exceeds remaining budget ({money(budget.allocated - _spent(db, budget.id)):.2f})")
    o = PurchaseOrder(**body.model_dump())
    o.isbn = catalog.normalize_isbn(o.isbn) or o.isbn
    db.add(o)
    db.flush()
    audit.record(db, "create", "order", o.id, actor=user, total=cost)
    db.commit()
    return _order_out(o)


@router.post("/orders/{order_id}/receive")
def receive(order_id: int, body: ReceiveIn, db: Session = Depends(get_db),
            user: Patron = Depends(require("acquisitions:write"))):
    """Receive an order: creates (or reuses) the bibliographic record and one item per copy."""
    o = db.get(PurchaseOrder, order_id)
    if o is None:
        raise NotFound("Order not found")
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
    o = db.get(PurchaseOrder, order_id)
    if o is None:
        raise NotFound("Order not found")
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
