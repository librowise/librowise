"""Course reserves.

A ``CourseItem`` holds the reserve settings for one physical item (or a whole title when no item is
given) and is shared by every course that reserves it. While at least one of those courses is active,
the optional overrides (a short-loan item type such as ``RES`` and/or a reserve shelf location) are
applied to the item and the item's previous values are remembered. When the last active course lets
go — the reserve is removed, the course is deactivated or deleted — the original values are restored.
A value that staff changed by hand while the item was on reserve is left alone on restore.
"""

from __future__ import annotations

from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session

from ..errors import Conflict, NotFound, PolicyBlocked
from ..models import (
    Biblio,
    CirculationRule,
    Course,
    CourseInstructor,
    CourseItem,
    CourseReserve,
    Item,
    ItemType,
    Loan,
    Patron,
)
from . import audit

RESERVE_ITEM_TYPE = "RES"
RESERVE_LOCATION = "Course reserves desk"


def ensure_reserve_item_type(db: Session) -> ItemType:
    """The short-loan item type used for course reserves (1-day loans, no renewals, not holdable)."""
    itype = db.scalar(select(ItemType).where(ItemType.code == RESERVE_ITEM_TYPE))
    if itype is None:
        itype = ItemType(code=RESERVE_ITEM_TYPE, name="Course reserve", holdable=False,
                         replacement_cost=50000)
        db.add(itype)
        db.flush()
        db.add(CirculationRule(item_type_id=itype.id, loan_days=1, max_renewals=0, fine_per_day=2000,
                               fine_cap=20000, grace_days=0, hold_pickup_days=1))
        db.flush()
    return itype


# ------------------------------------------------------------------ courses


def get_course(db: Session, course_id: int) -> Course:
    course = db.get(Course, course_id)
    if course is None:
        raise NotFound(f"Course {course_id} not found")
    return course


def _set_instructors(db: Session, course: Course, patron_ids: list[int]) -> None:
    ids = list(dict.fromkeys(int(i) for i in patron_ids))
    found = {p.id for p in db.scalars(select(Patron).where(Patron.id.in_(ids), Patron.deleted_at.is_(None)))} if ids else set()
    missing = [i for i in ids if i not in found]
    if missing:
        raise NotFound(f"Unknown instructor(s): {', '.join(map(str, missing))}")
    keep = {ci.patron_id: ci for ci in course.instructors}
    course.instructors = [keep.get(pid) or CourseInstructor(patron_id=pid) for pid in ids]


COURSE_FIELDS = ("code", "section", "name", "department", "term", "public_notes", "staff_notes")


def _check_unique(db: Session, course: Course) -> None:
    dup = db.scalar(select(Course.id).where(Course.code == course.code, Course.section == (course.section or ""),
                                            Course.term == (course.term or ""), Course.id != (course.id or 0)))
    if dup:
        raise Conflict(f"Course {course.code} {course.section or ''} already exists for term “{course.term or '—'}”")


def create_course(db: Session, data: dict, *, actor: Patron | None = None) -> Course:
    course = Course(**{k: data.get(k) for k in COURSE_FIELDS if k in data}, active=bool(data.get("active", True)))
    course.section = course.section or ""
    course.term = course.term or ""
    _check_unique(db, course)
    db.add(course)
    _set_instructors(db, course, data.get("instructor_ids") or [])
    db.flush()
    audit.record(db, "create", "course", course.id, actor=actor, code=course.code, term=course.term)
    return course


def update_course(db: Session, course: Course, data: dict, *, actor: Patron | None = None) -> dict:
    for k in COURSE_FIELDS:
        if k in data:
            setattr(course, k, data[k] if data[k] is not None or k not in ("section", "term") else "")
    _check_unique(db, course)
    if "instructor_ids" in data:
        _set_instructors(db, course, data["instructor_ids"] or [])
    result = {"swapped": 0, "restored": 0}
    if "active" in data and bool(data["active"]) != course.active:
        result = set_active(db, course, bool(data["active"]), actor=actor, audit_it=False)
    db.flush()
    audit.record(db, "update", "course", course.id, actor=actor, fields=sorted(data))
    return result


def set_active(db: Session, course: Course, active: bool, *, actor: Patron | None = None,
               audit_it: bool = True) -> dict:
    """Activate/deactivate a course, applying or restoring reserve overrides on its items."""
    course.active = active
    db.flush()
    result = {"swapped": 0, "restored": 0}
    for r in list(course.reserves):
        change = sync_course_item(db, r.course_item)
        if change:
            result[change] += 1
    if audit_it:
        audit.record(db, "activate" if active else "deactivate", "course", course.id, actor=actor, **result)
    return result


def bulk_set_active(db: Session, *, active: bool, course_ids: list[int] | None = None, term: str | None = None,
                    actor: Patron | None = None) -> dict:
    if not course_ids and not term:
        raise PolicyBlocked("Choose the courses or the term to update")
    stmt = select(Course).where(Course.active.is_(not active))
    if course_ids:
        stmt = stmt.where(Course.id.in_(course_ids))
    if term:
        stmt = stmt.where(Course.term == term)
    out = {"courses": 0, "swapped": 0, "restored": 0}
    for course in db.scalars(stmt).unique().all():
        r = set_active(db, course, active, actor=actor)
        out["courses"] += 1
        out["swapped"] += r["swapped"]
        out["restored"] += r["restored"]
    return out


def delete_course(db: Session, course: Course, *, actor: Patron | None = None) -> int:
    """Delete a course and its reserves, restoring every item it alone kept on reserve."""
    course_items = [r.course_item for r in course.reserves]
    audit.record(db, "delete", "course", course.id, actor=actor, code=course.code, reserves=len(course_items))
    db.delete(course)
    db.flush()
    restored = 0
    for ci in course_items:
        db.expire(ci, ["reserves"])
        if sync_course_item(db, ci) == "restored":
            restored += 1
    return restored


# ------------------------------------------------------------------ reserves


def _is_active(db: Session, ci: CourseItem) -> bool:
    db.flush()
    return bool(db.scalar(select(func.count()).select_from(CourseReserve).join(Course).where(
        CourseReserve.course_item_id == ci.id, Course.active.is_(True))))


def _restore(db: Session, ci: CourseItem) -> bool:
    item = ci.item
    if not ci.swapped or item is None:
        return False
    if ci.item_type_id and item.item_type_id == ci.item_type_id and ci.original_item_type_id:
        item.item_type = db.get(ItemType, ci.original_item_type_id)
    if ci.shelf_location is not None and item.shelf_location == ci.shelf_location:
        item.shelf_location = ci.original_shelf_location
    ci.swapped = False
    ci.original_item_type_id = None
    ci.original_shelf_location = None
    db.flush()
    return True


def _apply(db: Session, ci: CourseItem) -> bool:
    item = ci.item
    if item is None:
        return False
    first = not ci.swapped
    if first:
        ci.original_item_type_id = item.item_type_id
        ci.original_shelf_location = item.shelf_location
        ci.swapped = True
    if ci.item_type_id and item.item_type_id != ci.item_type_id:
        item.item_type = db.get(ItemType, ci.item_type_id)
    if ci.shelf_location is not None and item.shelf_location != ci.shelf_location:
        item.shelf_location = ci.shelf_location
    db.flush()
    return first


def sync_course_item(db: Session, ci: CourseItem) -> str | None:
    """Bring the item in line with its reserves. Returns "swapped", "restored" or None (no change).
    A course item left without any reserve is deleted."""
    if _is_active(db, ci):
        change = "swapped" if _apply(db, ci) else None
    else:
        change = "restored" if _restore(db, ci) else None
    has_reserves = db.scalar(select(func.count()).select_from(CourseReserve).where(CourseReserve.course_item_id == ci.id))
    if not has_reserves:
        db.delete(ci)
    db.flush()
    return change


def _validate_settings(db: Session, settings: dict) -> dict:
    out = {}
    if "item_type_id" in settings:
        tid = settings["item_type_id"]
        if tid is not None and db.get(ItemType, tid) is None:
            raise NotFound("Unknown item type")
        out["item_type_id"] = tid
    if "shelf_location" in settings:
        out["shelf_location"] = (settings["shelf_location"] or "").strip() or None
    return out


def update_course_item_settings(db: Session, ci: CourseItem, settings: dict) -> None:
    settings = _validate_settings(db, settings)
    if all(getattr(ci, k) == v for k, v in settings.items()):
        return
    was_swapped = _restore(db, ci)
    for k, v in settings.items():
        setattr(ci, k, v)
    if was_swapped or _is_active(db, ci):
        _apply(db, ci)
    db.flush()


def add_reserve(db: Session, course: Course, *, item: Item | None = None, biblio: Biblio | None = None,
                settings: dict | None = None, public_note: str | None = None, staff_note: str | None = None,
                actor: Patron | None = None) -> CourseReserve:
    """Put an item (or a whole title) on reserve for ``course``. ``settings`` may hold ``item_type_id``
    and/or ``shelf_location`` overrides; for an item already on reserve elsewhere, the settings given
    replace the shared ones."""
    settings = _validate_settings(db, settings or {})
    if item is not None:
        if item.deleted_at is not None:
            raise NotFound("Item not found")
        biblio = item.biblio
        ci = db.scalar(select(CourseItem).where(CourseItem.item_id == item.id))
    elif biblio is not None:
        if biblio.deleted_at is not None:
            raise NotFound("Record not found")
        ci = db.scalar(select(CourseItem).where(CourseItem.biblio_id == biblio.id, CourseItem.item_id.is_(None)))
    else:
        raise PolicyBlocked("Give an item barcode or a record to put on reserve")
    if ci is None:
        ci = CourseItem(biblio_id=biblio.id, item_id=item.id if item else None, swapped=False, **settings)
        ci.biblio, ci.item = biblio, item
        db.add(ci)
        db.flush()
    else:
        if db.scalar(select(CourseReserve.id).where(CourseReserve.course_id == course.id,
                                                    CourseReserve.course_item_id == ci.id)):
            what = f"Item {item.barcode}" if item else f"“{biblio.title}”"
            raise Conflict(f"{what} is already on reserve for {course.code}")
        if settings:
            update_course_item_settings(db, ci, settings)
    reserve = CourseReserve(course=course, course_item=ci, public_note=public_note, staff_note=staff_note)
    db.add(reserve)
    db.flush()
    change = sync_course_item(db, ci)
    audit.record(db, "add_reserve", "course", course.id, actor=actor, reserve=reserve.id,
                 item=item.barcode if item else None, biblio=biblio.id, swapped=change == "swapped" or None)
    return reserve


def remove_reserve(db: Session, reserve: CourseReserve, *, actor: Patron | None = None) -> str | None:
    ci, course = reserve.course_item, reserve.course
    audit.record(db, "remove_reserve", "course", course.id, actor=actor, reserve=reserve.id,
                 item=ci.item.barcode if ci.item else None, biblio=ci.biblio_id)
    if reserve in course.reserves:
        course.reserves.remove(reserve)
    if reserve in ci.reserves:
        ci.reserves.remove(reserve)
    db.delete(reserve)
    db.flush()
    return sync_course_item(db, ci)


# ------------------------------------------------------------------ queries


def search_courses(db: Session, *, q: str | None = None, department: str | None = None, term: str | None = None,
                   instructor: str | None = None, active: bool | None = None) -> list[Course]:
    stmt = select(Course)
    if active is not None:
        stmt = stmt.where(Course.active.is_(active))
    if department:
        stmt = stmt.where(Course.department == department)
    if term:
        stmt = stmt.where(Course.term == term)

    def by_instructor(text: str):
        like = f"%{text.strip()}%"
        return exists().where(CourseInstructor.course_id == Course.id, CourseInstructor.patron_id == Patron.id,
                              or_(Patron.first_name.ilike(like), Patron.last_name.ilike(like),
                                  (Patron.first_name + " " + Patron.last_name).ilike(like)))

    if instructor:
        stmt = stmt.where(by_instructor(instructor))
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Course.code.ilike(like), Course.name.ilike(like), Course.department.ilike(like),
                              by_instructor(q)))
    return list(db.scalars(stmt.order_by(Course.code, Course.section, Course.term).limit(500)).unique())


def facets(db: Session, *, active_only: bool = True) -> dict:
    base = select(Course.department, Course.term)
    if active_only:
        base = base.where(Course.active.is_(True))
    rows = db.execute(base).all()
    return {"departments": sorted({d for d, _ in rows if d}), "terms": sorted({t for _, t in rows if t})}


def open_loan_due(db: Session, item_ids: list[int]) -> dict[int, object]:
    if not item_ids:
        return {}
    return dict(db.execute(select(Loan.item_id, Loan.due_at).where(Loan.item_id.in_(item_ids),
                                                                   Loan.returned_at.is_(None))).all())
