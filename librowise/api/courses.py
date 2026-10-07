"""Course reserves: courses, instructors and reserve items — staff management and the public browse."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..errors import NotFound, PolicyBlocked
from ..models import Course, CourseItem, CourseReserve, Item, Patron
from ..schemas import StrictModel
from ..services import audit, catalog
from ..services import courses as svc

router = APIRouter(prefix="/courses", tags=["course reserves"])


# ------------------------------------------------------------------ schemas


class CourseIn(StrictModel):
    code: str = Field(min_length=1, max_length=32)
    section: str | None = Field(default=None, max_length=16)
    name: str = Field(min_length=1, max_length=200)
    department: str | None = Field(default=None, max_length=120)
    term: str | None = Field(default=None, max_length=40)
    active: bool = True
    public_notes: str | None = Field(default=None, max_length=4000)
    staff_notes: str | None = Field(default=None, max_length=4000)
    instructor_ids: list[int] = Field(default_factory=list, max_length=50)


class ReserveIn(StrictModel):
    barcode: str | None = Field(default=None, max_length=32)
    item_id: int | None = None
    biblio_id: int | None = Field(default=None, description="Reserve a whole title (no specific copy)")
    item_type_id: int | None = Field(default=None, description="Temporary (short-loan) item type while on reserve")
    shelf_location: str | None = Field(default=None, max_length=64, description="Temporary reserve location")
    public_note: str | None = Field(default=None, max_length=500)
    staff_note: str | None = Field(default=None, max_length=500)


class ReservePatch(StrictModel):
    item_type_id: int | None = None
    shelf_location: str | None = Field(default=None, max_length=64)
    public_note: str | None = Field(default=None, max_length=500)
    staff_note: str | None = Field(default=None, max_length=500)


class BulkStatusIn(StrictModel):
    active: bool = False
    course_ids: list[int] = Field(default_factory=list, max_length=1000)
    term: str | None = Field(default=None, max_length=40)


# ------------------------------------------------------------------ serialisers


def _instructors(c: Course, *, staff: bool) -> list[dict]:
    out = []
    for ci in sorted(c.instructors, key=lambda x: (x.patron.last_name, x.patron.first_name)):
        d = {"id": ci.patron.id, "name": ci.patron.full_name}
        if staff:
            d["card_number"] = ci.patron.card_number
        out.append(d)
    return out


def course_out(c: Course, *, staff: bool = False) -> dict:
    out = {"id": c.id, "code": c.code, "section": c.section or "", "name": c.name, "department": c.department,
           "term": c.term or "", "active": c.active, "public_notes": c.public_notes,
           "instructors": _instructors(c, staff=staff), "reserve_count": len(c.reserves)}
    if staff:
        out.update(staff_notes=c.staff_notes, created_at=c.created_at, updated_at=c.updated_at)
    return out


def reserve_out(db: Session, r: CourseReserve, avail: dict, due: dict, *, staff: bool = False) -> dict:
    ci = r.course_item
    b = ci.biblio
    out = {"id": r.id, "public_note": r.public_note,
           "biblio": {"id": b.id, "title": b.title, "authors": b.authors or [], "pub_year": b.pub_year,
                      "material_type": b.material_type, "cover_url": b.cover_url},
           "title_level": ci.item_id is None, "item": None,
           "availability": avail.get(b.id) if ci.item_id is None else None}
    if ci.item is not None:
        i = ci.item
        out["item"] = {"id": i.id, "barcode": i.barcode if staff else None, "status": i.status.value,
                       "call_number": i.call_number, "shelf_location": i.shelf_location,
                       "branch": {"id": i.branch.id, "name": i.branch.name},
                       "item_type": {"id": i.item_type.id, "code": i.item_type.code, "name": i.item_type.name},
                       "due_at": due.get(i.id), "withdrawn": i.deleted_at is not None}
    if staff:
        out.update(staff_note=r.staff_note, course_item_id=ci.id, swapped=ci.swapped,
                   reserve_item_type={"id": ci.item_type.id, "name": ci.item_type.name} if ci.item_type else None,
                   reserve_location=ci.shelf_location,
                   original_item_type={"id": ci.original_item_type.id, "name": ci.original_item_type.name}
                   if ci.original_item_type else None,
                   original_location=ci.original_shelf_location,
                   other_courses=[{"id": o.course.id, "code": o.course.code, "active": o.course.active}
                                  for o in ci.reserves if o.course_id != r.course_id])
    return out


def course_detail(db: Session, c: Course, *, staff: bool) -> dict:
    reserves = sorted(c.reserves, key=lambda r: (r.course_item.biblio.title.lower(), r.id))
    title_ids = [r.course_item.biblio_id for r in reserves if r.course_item.item_id is None]
    avail = catalog.availability(db, title_ids)
    due = svc.open_loan_due(db, [r.course_item.item_id for r in reserves if r.course_item.item_id])
    return {**course_out(c, staff=staff), "reserves": [reserve_out(db, r, avail, due, staff=staff) for r in reserves]}


# ------------------------------------------------------------------ public (OPAC)


@router.get("/public")
def public_courses(q: str | None = Query(default=None, max_length=120), department: str | None = None,
                   term: str | None = None, instructor: str | None = Query(default=None, max_length=120),
                   db: Session = Depends(get_db)):
    """Browse/search active courses by code, name, department or instructor (no authentication)."""
    rows = svc.search_courses(db, q=q, department=department, term=term, instructor=instructor, active=True)
    return {"total": len(rows), "results": [course_out(c) for c in rows], "facets": svc.facets(db)}


@router.get("/public/{course_id}")
def public_course(course_id: int, db: Session = Depends(get_db)):
    c = db.get(Course, course_id)
    if c is None or not c.active:
        raise NotFound("Course not found")
    return course_detail(db, c, staff=False)


# ------------------------------------------------------------------ staff


@router.get("")
def list_courses(q: str | None = Query(default=None, max_length=120), department: str | None = None,
                 term: str | None = None, active: bool | None = None, db: Session = Depends(get_db),
                 _: Patron = Depends(require("courses:read"))):
    rows = svc.search_courses(db, q=q, department=department, term=term, active=active)
    return {"total": len(rows), "results": [course_out(c, staff=True) for c in rows],
            "facets": svc.facets(db, active_only=False)}


@router.post("", status_code=201)
def create_course(body: CourseIn, db: Session = Depends(get_db), user: Patron = Depends(require("courses:write"))):
    c = svc.create_course(db, body.model_dump(), actor=user)
    db.commit()
    return course_detail(db, c, staff=True)


@router.post("/bulk-status")
def bulk_status(body: BulkStatusIn, db: Session = Depends(get_db), user: Patron = Depends(require("courses:write"))):
    """Bulk (de)activation, e.g. end of term: deactivating restores reserve items' original type/location."""
    result = svc.bulk_set_active(db, active=body.active, course_ids=body.course_ids or None, term=body.term,
                                 actor=user)
    db.commit()
    return result


@router.get("/{course_id}")
def get_course(course_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("courses:read"))):
    return course_detail(db, svc.get_course(db, course_id), staff=True)


@router.put("/{course_id}")
def update_course(course_id: int, body: CourseIn, db: Session = Depends(get_db),
                  user: Patron = Depends(require("courses:write"))):
    c = svc.get_course(db, course_id)
    result = svc.update_course(db, c, body.model_dump(), actor=user)
    db.commit()
    return {**course_detail(db, c, staff=True), "changes": result}


@router.delete("/{course_id}")
def delete_course(course_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("courses:write"))):
    restored = svc.delete_course(db, svc.get_course(db, course_id), actor=user)
    db.commit()
    return {"ok": True, "restored": restored}


@router.post("/{course_id}/reserves", status_code=201)
def add_reserve(course_id: int, body: ReserveIn, db: Session = Depends(get_db),
                user: Patron = Depends(require("courses:write"))):
    c = svc.get_course(db, course_id)
    item = biblio = None
    if body.barcode:
        item = catalog.item_by_barcode(db, body.barcode)
    elif body.item_id:
        item = db.get(Item, body.item_id)
        if item is None or item.deleted_at is not None:
            raise NotFound("Item not found")
    elif body.biblio_id:
        biblio = catalog.get_biblio(db, body.biblio_id)
    else:
        raise PolicyBlocked("Scan a barcode or choose a record to put on reserve")
    # Only values given here are applied; to clear a shared override, edit the reserve instead.
    settings = {k: v for k, v in body.model_dump(include={"item_type_id", "shelf_location"}).items() if v not in (None, "")}
    r = svc.add_reserve(db, c, item=item, biblio=biblio, settings=settings, public_note=body.public_note,
                        staff_note=body.staff_note, actor=user)
    db.commit()
    avail = catalog.availability(db, [r.course_item.biblio_id])
    due = svc.open_loan_due(db, [r.course_item.item_id] if r.course_item.item_id else [])
    return reserve_out(db, r, avail, due, staff=True)


def _reserve(db: Session, reserve_id: int) -> CourseReserve:
    r = db.get(CourseReserve, reserve_id)
    if r is None:
        raise NotFound("Reserve not found")
    return r


@router.patch("/reserves/{reserve_id}")
def update_reserve(reserve_id: int, body: ReservePatch, db: Session = Depends(get_db),
                   user: Patron = Depends(require("courses:write"))):
    r = _reserve(db, reserve_id)
    data = body.model_dump(exclude_unset=True)
    for k in ("public_note", "staff_note"):
        if k in data:
            setattr(r, k, data.pop(k))
    if data:
        svc.update_course_item_settings(db, r.course_item, data)
    audit.record(db, "update_reserve", "course", r.course_id, actor=user, reserve=r.id,
                 fields=sorted(body.model_dump(exclude_unset=True)))
    db.commit()
    avail = catalog.availability(db, [r.course_item.biblio_id])
    due = svc.open_loan_due(db, [r.course_item.item_id] if r.course_item.item_id else [])
    return reserve_out(db, r, avail, due, staff=True)


@router.delete("/reserves/{reserve_id}")
def remove_reserve(reserve_id: int, db: Session = Depends(get_db), user: Patron = Depends(require("courses:write"))):
    change = svc.remove_reserve(db, _reserve(db, reserve_id), actor=user)
    db.commit()
    return {"ok": True, "restored": change == "restored"}


@router.get("/items/{item_id}/reserves")
def item_reserves(item_id: int, db: Session = Depends(get_db), _: Patron = Depends(require("courses:read"))):
    """Which courses an item is on reserve for (used by staff screens)."""
    rows = db.scalars(select(CourseReserve).join(CourseItem).where(CourseItem.item_id == item_id)).all()
    return {"results": [{"reserve_id": r.id, "course": course_out(r.course, staff=True)} for r in rows]}
