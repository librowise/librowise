import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound
from ..models import AuditLog, Branch, CirculationRule, ItemType, Patron, PatronCategory, Role
from ..schemas import BranchIn, CategoryIn, ItemTypeIn, RuleIn, SettingIn, money
from ..services import audit, catalog, circulation
from ..services import settings as settings_svc

router = APIRouter(prefix="/admin", tags=["administration"])
ADMIN = require("admin")


def _crud(model, schema, entity: str, out):
    """Generate list/create/update/delete endpoints for a simple lookup table."""

    @router.get(f"/{entity}", name=f"list_{entity}")
    def list_(db: Session = Depends(get_db), _: Patron = Depends(require("catalog:read"))):
        return {"results": [out(r) for r in db.scalars(select(model).order_by(model.id))]}

    @router.post(f"/{entity}", status_code=201, name=f"create_{entity}")
    def create(body: schema, db: Session = Depends(get_db), user: Patron = Depends(ADMIN)):  # type: ignore[valid-type]
        row = model(**body.model_dump())
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "A record with that code already exists") from None
        audit.record(db, "create", entity, row.id, actor=user)
        db.commit()
        return out(row)

    @router.put(f"/{entity}/{{row_id}}", name=f"update_{entity}")
    def update(row_id: int, body: schema, db: Session = Depends(get_db), user: Patron = Depends(ADMIN)):  # type: ignore[valid-type]
        row = db.get(model, row_id)
        if row is None:
            raise NotFound(f"{entity} {row_id} not found")
        for k, v in body.model_dump(exclude_unset=True).items():  # partial updates keep other fields
            setattr(row, k, v)
        audit.record(db, "update", entity, row.id, actor=user)
        db.commit()
        return out(row)

    @router.delete(f"/{entity}/{{row_id}}", name=f"delete_{entity}")
    def delete(row_id: int, db: Session = Depends(get_db), user: Patron = Depends(ADMIN)):
        row = db.get(model, row_id)
        if row is None:
            raise NotFound(f"{entity} {row_id} not found")
        db.delete(row)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, f"This {entity[:-1]} is still in use") from None
        audit.record(db, "delete", entity, row_id, actor=user)
        db.commit()
        return {"ok": True}


_crud(Branch, BranchIn, "branches",
      lambda b: {"id": b.id, "code": b.code, "name": b.name, "address": b.address, "email": b.email, "phone": b.phone})
_crud(ItemType, ItemTypeIn, "item-types",
      lambda t: {"id": t.id, "code": t.code, "name": t.name, "holdable": t.holdable, "replacement_cost": t.replacement_cost})
_crud(PatronCategory, CategoryIn, "categories",
      lambda c: {"id": c.id, "code": c.code, "name": c.name, "max_loans": c.max_loans, "max_holds": c.max_holds,
                 "enrollment_months": c.enrollment_months, "block_fine_threshold": c.block_fine_threshold})
_crud(CirculationRule, RuleIn, "rules",
      lambda r: {"id": r.id, "branch_id": r.branch_id, "category_id": r.category_id, "item_type_id": r.item_type_id,
                 "branch": r.branch.name if r.branch else "Any", "category": r.category.name if r.category else "Any",
                 "item_type": r.item_type.name if r.item_type else "Any", "loan_days": r.loan_days,
                 "max_renewals": r.max_renewals, "fine_per_day": r.fine_per_day, "fine_cap": r.fine_cap,
                 "grace_days": r.grace_days, "hold_pickup_days": r.hold_pickup_days})


@router.get("/rules/explain")
def explain_rule(branch_id: int, category_id: int, item_type_id: int, db: Session = Depends(get_db),
                 _: Patron = Depends(require("catalog:read"))):
    """Show exactly which rule applies to a combination — and why."""
    r = circulation.resolve_rule(db, branch_id, category_id, item_type_id)
    return {"effective": r.__dict__, "fine_per_day": money(r.fine_per_day), "fine_cap": money(r.fine_cap),
            "explanation": f"Matched rule #{r.source_rule_id}" if r.source_rule_id else "No rule matched; built-in defaults apply"}


@router.get("/settings")
def get_settings(db: Session = Depends(get_db), _: Patron = Depends(require("settings:manage"))):
    return {"results": settings_svc.all_settings(db)}


@router.put("/settings/{key}")
def put_setting(key: str, body: SettingIn, db: Session = Depends(get_db), user: Patron = Depends(require("settings:manage"))):
    try:
        settings_svc.set_value(db, key, body.value)
    except KeyError:
        raise NotFound("Unknown setting") from None
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from None
    audit.record(db, "setting", "settings", None, actor=user, key=key, value=body.value)
    db.commit()
    return {"key": key, "value": settings_svc.get(db, key)}


@router.get("/audit")
def audit_log(action: str | None = None, entity: str | None = None, page: int = Query(default=1, ge=1),
              db: Session = Depends(get_db), _: Patron = Depends(require("audit:read"))):
    stmt = select(AuditLog)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if entity:
        stmt = stmt.where(AuditLog.entity == entity)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditLog.id.desc()).offset((page - 1) * 50).limit(50)).all()
    return {"total": total, "results": [
        {"id": a.id, "at": a.at, "action": a.action, "entity": a.entity, "entity_id": a.entity_id,
         "actor": a.actor.full_name if a.actor else None, "ip": a.ip, "details": a.details} for a in rows]}


@router.post("/jobs/nightly")
def nightly(db: Session = Depends(get_db), user: Patron = Depends(require("jobs:manage"))):
    stats = circulation.run_nightly(db)
    audit.record(db, "nightly_job", "system", None, actor=user, **stats)
    db.commit()
    return stats


@router.post("/jobs/reindex")
def reindex(db: Session = Depends(get_db), _: Patron = Depends(require("jobs:manage"))):
    n = catalog.reindex_all(db)
    db.commit()
    from ..ai import semantic
    semantic.index.invalidate()
    return {"indexed": n}


@router.post("/import/patrons")
async def import_patrons(file: UploadFile = File(...), db: Session = Depends(get_db), user: Patron = Depends(ADMIN)):
    """Import patrons from CSV. Accepts Koha borrower export column names
    (cardnumber, surname, firstname, email, phone, address, categorycode, branchcode, dateexpiry)."""
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    cats = {c.code: c for c in db.scalars(select(PatronCategory))}
    branches = {b.code: b for b in db.scalars(select(Branch))}
    stats = {"created": 0, "skipped": 0, "errors": []}
    for n, row in enumerate(reader, start=2):
        row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        card = row.get("cardnumber") or row.get("card_number")
        if not card or db.scalar(select(Patron.id).where(Patron.card_number == card)):
            stats["skipped"] += 1
            continue
        cat = cats.get(row.get("categorycode", "").upper()) or next(iter(cats.values()), None)
        br = branches.get(row.get("branchcode", "").upper()) or next(iter(branches.values()), None)
        if not cat or not br:
            stats["errors"].append(f"Line {n}: unknown category/branch")
            continue
        email = row.get("email") or None
        if email and db.scalar(select(Patron.id).where(Patron.email == email.lower())):
            email = None
        try:
            exp = date.fromisoformat(row["dateexpiry"]) if row.get("dateexpiry") else None
        except ValueError:
            exp = None
        db.add(Patron(card_number=card, first_name=row.get("firstname") or row.get("first_name") or "",
                      last_name=row.get("surname") or row.get("last_name") or "(unknown)",
                      email=email.lower() if email else None, phone=row.get("phone") or None,
                      address=row.get("address") or None, category_id=cat.id, home_branch_id=br.id,
                      role=Role.patron, expires_on=exp))
        stats["created"] += 1
    audit.record(db, "import", "patron", None, actor=user, created=stats["created"])
    db.commit()
    return stats
