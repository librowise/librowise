"""Batch item tools (modify, withdraw, delete) and inventory/stocktake.

Every batch runs in two steps with identical logic: a *preview* (``dry_run``) that reports, per
item, exactly what would change or why it would be skipped, and an *apply* that recomputes the
plan against the current database state and performs it.
"""

from __future__ import annotations

import csv
import io
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import DomainError
from ..models import Biblio, Branch, Hold, HoldStatus, Item, ItemStatus, ItemType, utcnow
from . import catalog

MAX_ITEMS = 5000
EDITABLE_STATUSES = ("available", "processing", "lost", "damaged", "withdrawn")
PROTECTED = {
    ItemStatus.on_loan: "on loan — check it in first",
    ItemStatus.on_hold_shelf: "waiting on the hold shelf for a patron",
    ItemStatus.in_transit: "in transit between branches",
}
FIELD_LABELS = {"branch_id": "Home branch", "item_type_id": "Item type", "shelf_location": "Shelf location",
                "status": "Status", "notes": "Notes", "call_number": "Call number"}


def parse_barcodes(value) -> list[str]:
    if value is None:
        return []
    parts = value if isinstance(value, list | tuple) else re.split(r"[\s,;]+", str(value))
    return list(dict.fromkeys(p.strip() for p in parts if p and str(p).strip()))


# ------------------------------------------------------------------ selection


def select_items(db: Session, selection: Mapping) -> tuple[list[Item], list[str]]:
    """Items from a barcode list, or from a catalogue search plus item filters (saved-search style)."""
    base = select(Item).where(Item.deleted_at.is_(None))
    if selection.get("barcodes"):
        wanted = parse_barcodes(selection["barcodes"])
        if len(wanted) > MAX_ITEMS:
            raise DomainError(f"At most {MAX_ITEMS} barcodes per batch", code="validation_error")
        found: dict[str, Item] = {}
        for i in range(0, len(wanted), 900):
            found.update({x.barcode: x for x in db.scalars(base.where(Item.barcode.in_(wanted[i:i + 900])))})
        return [found[b] for b in wanted if b in found], [b for b in wanted if b not in found]
    s = selection.get("search") or {}
    criteria = {k: v for k, v in s.items() if v not in (None, "", False)}
    if not criteria:
        raise DomainError("Provide barcodes or at least one search criterion", code="validation_error")
    stmt = base
    if criteria.get("q") or criteria.get("material_type"):
        f = catalog.SearchFilters(material_type=criteria.get("material_type"))
        res = catalog.search(db, criteria.get("q"), f, per_page=MAX_ITEMS, sort="title")
        stmt = stmt.where(Item.biblio_id.in_(res.ids or [-1]))
    if criteria.get("branch_id"):
        stmt = stmt.where(Item.branch_id == int(criteria["branch_id"]))
    if criteria.get("item_type_id"):
        stmt = stmt.where(Item.item_type_id == int(criteria["item_type_id"]))
    if criteria.get("status"):
        stmt = stmt.where(Item.status == ItemStatus(criteria["status"]))
    if "shelf_location" in criteria:
        loc = str(criteria["shelf_location"]).strip()
        stmt = stmt.where(Item.shelf_location.is_(None) if loc == "(none)" else func.lower(Item.shelf_location) == loc.lower())
    if criteria.get("call_number_prefix"):
        stmt = stmt.where(Item.call_number.like(f"{_like_escape(criteria['call_number_prefix'])}%", escape="\\"))
    items = list(db.scalars(stmt.order_by(Item.call_number, Item.barcode).limit(MAX_ITEMS + 1)))
    if len(items) > MAX_ITEMS:
        raise DomainError(f"The search matches more than {MAX_ITEMS} items — narrow it down", code="validation_error")
    return items, []


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ------------------------------------------------------------------ modify


def _validate_changes(db: Session, changes: Mapping) -> dict:
    ch = {k: v for k, v in changes.items() if k in ("branch_id", "item_type_id", "shelf_location", "status", "notes",
                                                     "notes_mode", "call_number_prefix", "call_number_prefix_mode")}
    if "branch_id" in ch and (ch["branch_id"] is None or not db.get(Branch, ch["branch_id"])):
        raise DomainError("Unknown branch", code="validation_error")
    if "item_type_id" in ch and (ch["item_type_id"] is None or not db.get(ItemType, ch["item_type_id"])):
        raise DomainError("Unknown item type", code="validation_error")
    if "status" in ch and ch["status"] not in EDITABLE_STATUSES:
        raise DomainError(f"Status must be one of {', '.join(EDITABLE_STATUSES)}", code="validation_error")
    mode = ch.get("notes_mode") or "replace"
    if mode not in ("replace", "append", "clear"):
        raise DomainError("Notes mode must be replace, append or clear", code="validation_error")
    ch["notes_mode"] = mode
    if "notes" not in ch and mode != "clear":
        ch.pop("notes_mode")
    pmode = ch.get("call_number_prefix_mode") or "add"
    if pmode not in ("add", "remove"):
        raise DomainError("Call number prefix mode must be add or remove", code="validation_error")
    if ch.get("call_number_prefix"):
        ch["call_number_prefix"] = str(ch["call_number_prefix"]).strip()
        ch["call_number_prefix_mode"] = pmode
    else:
        ch.pop("call_number_prefix", None)
        ch.pop("call_number_prefix_mode", None)
    if "shelf_location" in ch:
        ch["shelf_location"] = (str(ch["shelf_location"]).strip() or None) if ch["shelf_location"] is not None else None
    if not any(k in ch for k in ("branch_id", "item_type_id", "shelf_location", "status", "notes_mode", "call_number_prefix")):
        raise DomainError("Choose at least one change to make", code="validation_error")
    return ch


def _new_call_number(current: str | None, prefix: str, mode: str) -> str | None:
    cn = (current or "").strip()
    if mode == "add":
        if cn == prefix or cn.startswith(prefix + " "):
            return current
        return f"{prefix} {cn}".strip()
    if cn == prefix:
        return None
    if cn.startswith(prefix + " "):
        return cn[len(prefix) + 1:].strip() or None
    return current


def _display(db: Session, field: str, value, cache: dict) -> str | None:
    if value is None:
        return None
    if field in ("branch_id", "item_type_id"):
        model = Branch if field == "branch_id" else ItemType
        key = (field, value)
        if key not in cache:
            row = db.get(model, value)
            cache[key] = row.name if row else str(value)
        return cache[key]
    return value.value if isinstance(value, ItemStatus) else str(value)


def _row(item: Item) -> dict:
    return {"item_id": item.id, "barcode": item.barcode, "biblio_id": item.biblio_id, "title": item.biblio.title,
            "call_number": item.call_number, "status": item.status.value, "branch": item.branch.name,
            "shelf_location": item.shelf_location}


def plan_modify(db: Session, items: Iterable[Item], changes: Mapping) -> list[dict]:
    ch = _validate_changes(db, changes)
    cache: dict = {}
    rows = []
    for item in items:
        row = _row(item)
        after: dict = {}
        if "status" in ch and ch["status"] != item.status.value and item.status in PROTECTED:
            rows.append({**row, "result": "skipped", "reason": f"Item is {PROTECTED[item.status]}", "changes": []})
            continue
        if "branch_id" in ch:
            after["branch_id"] = ch["branch_id"]
        if "item_type_id" in ch:
            after["item_type_id"] = ch["item_type_id"]
        if "shelf_location" in ch:
            after["shelf_location"] = ch["shelf_location"]
        if "status" in ch:
            after["status"] = ItemStatus(ch["status"])
        if "notes_mode" in ch:
            mode, text = ch["notes_mode"], (ch.get("notes") or "").strip()
            if mode == "clear" or (mode == "replace" and not text):
                after["notes"] = None
            elif mode == "replace":
                after["notes"] = text
            else:
                after["notes"] = f"{item.notes}\n{text}" if item.notes and text else (item.notes or text or None)
        if "call_number_prefix" in ch:
            new_cn = _new_call_number(item.call_number, ch["call_number_prefix"], ch["call_number_prefix_mode"])
            if new_cn and len(new_cn) > 64:
                rows.append({**row, "result": "skipped", "reason": "Call number would exceed 64 characters",
                             "changes": []})
                continue
            after["call_number"] = new_cn
        diffs = []
        for field, value in after.items():
            before = getattr(item, field)
            if before != value:
                diffs.append({"field": field, "label": FIELD_LABELS[field], "before": _display(db, field, before, cache),
                              "after": _display(db, field, value, cache), "_value": value})
        if len(str(after.get("notes") or "")) > 2000:
            rows.append({**row, "result": "skipped", "reason": "Notes would exceed 2000 characters", "changes": []})
            continue
        rows.append({**row, "result": "change" if diffs else "unchanged", "reason": None, "changes": diffs})
    return rows


def apply_modify(db: Session, items: list[Item], changes: Mapping) -> list[dict]:
    rows = plan_modify(db, items, changes)
    by_id = {i.id: i for i in items}
    now = utcnow()
    for row in rows:
        if row["result"] != "change":
            continue
        item = by_id[row["item_id"]]
        for d in row["changes"]:
            setattr(item, d["field"], d["_value"])
        item.updated_at = now
        row["result"] = "changed"
    db.flush()
    return rows


def public_rows(rows: list[dict]) -> list[dict]:
    return [{**r, "changes": [{k: v for k, v in d.items() if not k.startswith("_")} for d in r.get("changes", [])]}
            for r in rows]


def tally(rows: list[dict]) -> dict:
    return dict(Counter(r["result"] for r in rows))


# ------------------------------------------------------------------ withdraw / delete


def plan_delete(db: Session, items: Iterable[Item], action: str) -> list[dict]:
    if action not in ("withdraw", "delete"):
        raise DomainError("Action must be withdraw or delete", code="validation_error")
    items = list(items)
    waiting = set(db.scalars(select(Hold.item_id).where(Hold.item_id.in_([i.id for i in items] or [-1]),
                                                        Hold.status == HoldStatus.ready)))
    rows = []
    for item in items:
        row = _row(item)
        if item.status in PROTECTED:
            rows.append({**row, "result": "skipped", "reason": f"Item is {PROTECTED[item.status]}"})
        elif item.id in waiting:
            rows.append({**row, "result": "skipped", "reason": "Item is allocated to a hold"})
        elif action == "withdraw" and item.status == ItemStatus.withdrawn:
            rows.append({**row, "result": "unchanged", "reason": "Already withdrawn"})
        else:
            rows.append({**row, "result": action, "reason": None})
    return rows


def apply_delete(db: Session, items: list[Item], action: str, *, delete_empty_biblios: bool = False) -> dict:
    rows = plan_delete(db, items, action)
    by_id = {i.id: i for i in items}
    now = utcnow()
    touched: set[int] = set()
    for row in rows:
        if row["result"] != action:
            continue
        item = by_id[row["item_id"]]
        if action == "withdraw":
            item.status = ItemStatus.withdrawn
            row["result"] = "withdrawn"
        else:
            item.deleted_at = now
            row["result"] = "deleted"
            touched.add(item.biblio_id)
        item.updated_at = now
    db.flush()
    removed = []
    if delete_empty_biblios and touched:
        for b in db.scalars(select(Biblio).where(Biblio.id.in_(touched), Biblio.deleted_at.is_(None))):
            live = db.scalar(select(func.count()).select_from(Item).where(Item.biblio_id == b.id, Item.deleted_at.is_(None)))
            holds = db.scalar(select(func.count()).select_from(Hold).where(
                Hold.biblio_id == b.id, Hold.status.in_([HoldStatus.queued, HoldStatus.ready])))
            if not live and not holds:
                catalog.delete_biblio(db, b)
                removed.append({"biblio_id": b.id, "title": b.title})
    db.flush()
    return {"rows": rows, "biblios_deleted": removed}


# ------------------------------------------------------------------ inventory / stocktake

ON_SHELF = (ItemStatus.available,)
STATUS_PROBLEMS = {
    ItemStatus.on_loan: ("on_loan", "Recorded as on loan but found on the shelf", "checkin"),
    ItemStatus.lost: ("lost", "Recorded as lost but found", "checkin"),
    ItemStatus.withdrawn: ("withdrawn", "Withdrawn item still on the shelf", None),
    ItemStatus.in_transit: ("in_transit", "Recorded as in transit", "checkin"),
    ItemStatus.on_hold_shelf: ("on_hold_shelf", "Should be on the hold shelf", None),
    ItemStatus.damaged: ("damaged", "Marked damaged", None),
    ItemStatus.processing: ("processing", "Still marked as in processing", None),
}


def _in_range(cn: str | None, lo: str | None, hi: str | None) -> bool:
    key = (cn or "").strip().upper()
    if lo and key < lo.strip().upper():
        return False
    return not (hi and key > hi.strip().upper() and not key.startswith(hi.strip().upper()))


def _loc_matches(item: Item, location: str | None) -> bool:
    if location is None:
        return True
    if location == "(none)":
        return item.shelf_location is None
    return (item.shelf_location or "").strip().lower() == location.strip().lower()


def run_inventory(db: Session, *, branch_id: int, barcodes, shelf_location: str | None = None,
                  call_number_from: str | None = None, call_number_to: str | None = None,
                  item_type_id: int | None = None, mark_seen: bool = True, now: datetime | None = None) -> dict:
    """Compare scanned barcodes with what the catalogue says should be on a shelf."""
    branch = db.get(Branch, branch_id)
    if branch is None:
        raise DomainError("Unknown branch", code="validation_error")
    now = now or utcnow()
    location = (shelf_location or "").strip() or None
    raw = [str(b).strip() for b in (barcodes if isinstance(barcodes, list | tuple) else re.split(r"[\s,;]+", str(barcodes or ""))) if str(b).strip()]
    if len(raw) > 20000:
        raise DomainError("At most 20000 scans per inventory run", code="validation_error")
    counts = Counter(raw)
    scanned = list(dict.fromkeys(raw))

    def in_scope(item: Item) -> bool:
        return (item.branch_id == branch_id and _loc_matches(item, location)
                and (item_type_id is None or item.item_type_id == item_type_id)
                and _in_range(item.call_number, call_number_from, call_number_to))

    found: dict[str, Item] = {}
    for i in range(0, len(scanned), 900):
        found.update({x.barcode: x for x in db.scalars(select(Item).where(
            Item.barcode.in_(scanned[i:i + 900]), Item.deleted_at.is_(None)))})
    rows, unknown = [], []
    for bc in scanned:
        item = found.get(bc)
        if item is None:
            unknown.append(bc)
            continue
        problems, action = [], None
        if not in_scope(item):
            where = item.branch.name + (f" · {item.shelf_location}" if item.shelf_location else "")
            problems.append({"code": "out_of_place", "message": f"Belongs to {where}"})
        if item.status in STATUS_PROBLEMS:
            code, msg, act = STATUS_PROBLEMS[item.status]
            problems.append({"code": code, "message": msg})
            action = action or act
        rows.append({**_row(item), "last_seen_at": item.last_seen_at, "scans": counts[bc],
                     "result": "ok" if not problems else ("out_of_place" if problems[0]["code"] == "out_of_place"
                                                           else "wrong_status"),
                     "problems": problems, "action": action})
        if mark_seen:
            item.last_seen_at = now
    expected_stmt = select(Item).where(Item.deleted_at.is_(None), Item.branch_id == branch_id,
                                       Item.status.in_(ON_SHELF))
    if item_type_id:
        expected_stmt = expected_stmt.where(Item.item_type_id == item_type_id)
    seen = set(found)
    missing = []
    for item in db.scalars(expected_stmt.order_by(Item.call_number, Item.barcode)):
        if item.barcode in seen or not in_scope(item):
            continue
        missing.append({**_row(item), "last_seen_at": item.last_seen_at, "result": "missing",
                        "problems": [{"code": "missing", "message": "Expected on this shelf but not scanned"}],
                        "action": None})
    db.flush()
    by_result = Counter(r["result"] for r in rows)
    return {
        "branch": {"id": branch.id, "name": branch.name}, "shelf_location": location,
        "call_number_from": call_number_from, "call_number_to": call_number_to, "run_at": now,
        "summary": {"scanned": len(raw), "unique": len(scanned), "ok": by_result.get("ok", 0),
                    "out_of_place": by_result.get("out_of_place", 0), "wrong_status": by_result.get("wrong_status", 0),
                    "unknown": len(unknown), "missing": len(missing),
                    "duplicates": sum(1 for n in counts.values() if n > 1), "marked_seen": len(found) if mark_seen else 0},
        "scanned": rows, "missing": missing, "unknown": unknown,
    }


def _safe(value) -> str:
    s = "" if value is None else str(value)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def inventory_csv(report: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["result", "barcode", "title", "call_number", "branch", "shelf_location", "status", "problems",
                "last_seen_at"])
    for r in [*report["scanned"], *report["missing"]]:
        w.writerow([_safe(x) for x in (r["result"], r["barcode"], r["title"], r["call_number"], r["branch"],
                                        r["shelf_location"], r["status"],
                                        "; ".join(p["message"] for p in r["problems"]), r["last_seen_at"])])
    for bc in report["unknown"]:
        w.writerow([_safe(x) for x in ("unknown", bc, "", "", "", "", "", "Barcode not in catalogue", "")])
    return buf.getvalue()


def shelf_locations(db: Session, branch_id: int | None = None) -> list[dict]:
    stmt = select(Item.shelf_location, func.count()).where(Item.deleted_at.is_(None))
    if branch_id:
        stmt = stmt.where(Item.branch_id == branch_id)
    rows = db.execute(stmt.group_by(Item.shelf_location).order_by(Item.shelf_location)).all()
    return [{"value": loc if loc is not None else "(none)", "label": loc or "(no location)", "items": n} for loc, n in rows]
