"""Label and patron-card sheets: layouts, batch selection, pagination and cell content.

A *layout* is the geometry of a sheet of labels (page size, rows x cols, margins, gutters,
label size — all millimetres). A print job fills the sheet left-to-right, top-to-bottom,
starting at ``start`` (1-based) so partly used sheets can be reused.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..errors import DomainError, NotFound
from ..models import Item, LabelLayout, Patron, utcnow
from . import barcodes
from . import settings as settings_svc

PAGE_SIZES = {"A4": (210.0, 297.0), "Letter": (215.9, 279.4)}
KINDS = ("spine", "item", "patron")
MAX_LABELS = 5000

PRESETS: list[dict] = [
    {"name": "Avery L7160 — 21 per A4 (63.5 × 38.1 mm)", "kind": "item", "page_size": "A4", "rows": 7, "cols": 3,
     "margin_top": 15.15, "margin_left": 7.2, "gutter_x": 2.5, "gutter_y": 0, "label_width": 63.5,
     "label_height": 38.1, "padding": 2.5, "font_size": 8},
    {"name": "Avery L7651 — 65 per A4 (38.1 × 21.2 mm)", "kind": "item", "page_size": "A4", "rows": 13, "cols": 5,
     "margin_top": 10.7, "margin_left": 4.65, "gutter_x": 2.5, "gutter_y": 0, "label_width": 38.1,
     "label_height": 21.2, "padding": 1.2, "font_size": 6},
    {"name": "Avery 5160 — 30 per Letter (2⅝ × 1 in)", "kind": "item", "page_size": "Letter", "rows": 10, "cols": 3,
     "margin_top": 12.7, "margin_left": 4.76, "gutter_x": 3.18, "gutter_y": 0, "label_width": 66.68,
     "label_height": 25.4, "padding": 1.5, "font_size": 7},
    {"name": "Spine labels — 60 per A4 (30 × 25 mm)", "kind": "spine", "page_size": "A4", "rows": 10, "cols": 6,
     "margin_top": 14.5, "margin_left": 7.5, "gutter_x": 3, "gutter_y": 2, "label_width": 30, "label_height": 25,
     "padding": 1.5, "font_size": 10},
    {"name": "Avery 5167 — 80 per Letter (1¾ × ½ in)", "kind": "spine", "page_size": "Letter", "rows": 20, "cols": 4,
     "margin_top": 12.7, "margin_left": 7.62, "gutter_x": 7.62, "gutter_y": 0, "label_width": 44.45,
     "label_height": 12.7, "padding": 0.8, "font_size": 7},
    {"name": "Patron cards — 10 per A4 (CR80, 85.6 × 54 mm)", "kind": "patron", "page_size": "A4", "rows": 5, "cols": 2,
     "margin_top": 9.5, "margin_left": 16.9, "gutter_x": 5, "gutter_y": 2, "label_width": 85.6, "label_height": 54,
     "padding": 3, "font_size": 9},
    {"name": "Avery 5371 business cards — 10 per Letter (3½ × 2 in)", "kind": "patron", "page_size": "Letter",
     "rows": 5, "cols": 2, "margin_top": 12.7, "margin_left": 19.05, "gutter_x": 0, "gutter_y": 0,
     "label_width": 88.9, "label_height": 50.8, "padding": 3, "font_size": 9},
]
LAYOUT_FIELDS = ("name", "kind", "page_size", "page_width", "page_height", "rows", "cols", "margin_top", "margin_left",
                 "gutter_x", "gutter_y", "label_width", "label_height", "padding", "font_size")


# ------------------------------------------------------------------ layouts


def ensure_presets(db: Session) -> int:
    """Insert any missing preset layouts. Returns how many were added."""
    have = set(db.scalars(select(LabelLayout.name)))
    added = 0
    for p in PRESETS:
        if p["name"] not in have:
            w, h = PAGE_SIZES[p["page_size"]]
            db.add(LabelLayout(**p, page_width=w, page_height=h, is_preset=True))
            added += 1
    if added:
        db.flush()
    return added


def layout_out(layout: LabelLayout) -> dict:
    out = {k: getattr(layout, k) for k in LAYOUT_FIELDS}
    out.update(id=layout.id, is_preset=layout.is_preset, per_sheet=layout.rows * layout.cols)
    return out


def validate_layout(data: Mapping) -> dict:
    """Clean and check a layout definition; raises DomainError with every problem found."""
    d = {k: data.get(k) for k in LAYOUT_FIELDS if k in data}
    problems = []
    if d.get("page_size") in PAGE_SIZES:
        d["page_width"], d["page_height"] = PAGE_SIZES[d["page_size"]]
    elif d.get("page_size") not in (None, "custom"):
        problems.append("Page size must be A4, Letter or custom")
    if d.get("kind") not in (*KINDS, "any"):
        problems.append("Kind must be spine, item, patron or any")
    nums = ("page_width", "page_height", "margin_top", "margin_left", "gutter_x", "gutter_y", "label_width",
            "label_height", "padding", "font_size")
    for k in nums:
        try:
            d[k] = round(float(d[k]), 2)
        except (TypeError, ValueError, KeyError):
            problems.append(f"{k.replace('_', ' ').capitalize()} must be a number")
    for k in ("rows", "cols"):
        try:
            d[k] = int(d[k])
            if not 1 <= d[k] <= 60:
                problems.append(f"{k.capitalize()} must be between 1 and 60")
        except (TypeError, ValueError, KeyError):
            problems.append(f"{k.capitalize()} must be a whole number")
    if problems:
        raise DomainError("; ".join(problems), code="validation_error", details={"problems": problems})
    if any(d[k] < 0 for k in nums) or d["label_width"] <= 0 or d["label_height"] <= 0 or d["font_size"] < 3:
        problems.append("Sizes must be positive (font size at least 3 pt)")
    width = d["margin_left"] + d["cols"] * d["label_width"] + (d["cols"] - 1) * d["gutter_x"]
    height = d["margin_top"] + d["rows"] * d["label_height"] + (d["rows"] - 1) * d["gutter_y"]
    if width > d["page_width"] + 0.5:
        problems.append(f"Labels are {width:.1f} mm wide in total but the page is {d['page_width']:g} mm")
    if height > d["page_height"] + 0.5:
        problems.append(f"Labels are {height:.1f} mm tall in total but the page is {d['page_height']:g} mm")
    if 2 * d["padding"] >= min(d["label_width"], d["label_height"]):
        problems.append("Padding leaves no room for content")
    name = str(d.get("name") or "").strip()
    if not name:
        problems.append("A name is required")
    d["name"] = name[:120]
    if problems:
        raise DomainError("; ".join(problems), code="validation_error", details={"problems": problems})
    return d


def get_layout(db: Session, layout_id: int) -> LabelLayout:
    layout = db.get(LabelLayout, layout_id)
    if layout is None:
        raise NotFound("Label layout not found")
    return layout


# ------------------------------------------------------------------ pagination & content


def paginate(entries: list, rows: int, cols: int, start: int = 1) -> list[list]:
    """Fill sheets from cell ``start`` (1-based); blank cells are ``None``. Every page has rows*cols cells."""
    per = rows * cols
    start = min(max(int(start or 1), 1), per)
    if not entries:
        return []
    cells = [None] * (start - 1) + list(entries)
    pages = [cells[i:i + per] for i in range(0, len(cells), per)]
    pages[-1] = pages[-1] + [None] * (per - len(pages[-1]))
    return pages


_LC = re.compile(r"^([A-Z]{1,3})(\d+(?:\.\d+)?)$")
_DEWEY = re.compile(r"^(\d{1,3})(\.\d+)$")


def split_call_number(call_number: str | None, *, split_decimal: bool = False, max_lines: int = 6) -> list[str]:
    """Spine label lines: "823.912 CHR" -> ["823.912", "CHR"]; LC "QA76.73 .P98 2019" -> ["QA", "76.73", ".P98", "2019"]."""
    lines: list[str] = []
    for n, token in enumerate((call_number or "").split()):
        if n == 0 and (m := _LC.match(token)):  # only the class number splits; "M37" is a cutter
            lines += [m.group(1), m.group(2)]
        elif split_decimal and (m := _DEWEY.match(token)):
            lines += [m.group(1), m.group(2)]
        else:
            lines.append(token)
    if len(lines) > max_lines:
        lines = lines[:max_lines - 1] + [" ".join(lines[max_lines - 1:])]
    return lines


def _barcode_svg(value: str) -> tuple[str | None, str | None]:
    """Bars only: the SVG stretches to fill the label, so the human-readable text is set in HTML."""
    try:
        return barcodes.svg(value, height=30, text=False), None
    except ValueError as exc:
        return None, str(exc)


def fit_font(lines: list[str], layout: LabelLayout) -> float:
    """Largest font size (pt, at most the layout's) at which every line fits the label."""
    if not lines:
        return layout.font_size
    pt = 0.3528  # millimetres per point
    by_height = (layout.label_height - 2 * layout.padding) / (len(lines) * 1.2 * pt)
    by_width = (layout.label_width - 2 * layout.padding) / (max(len(x) for x in lines) * 0.62 * pt)
    return max(math.floor(min(layout.font_size, by_height, by_width) * 10) / 10, 4.0)


def item_entry(item: Item, kind: str, *, split_decimal: bool = False) -> dict:
    svg, error = _barcode_svg(item.barcode) if kind == "item" else (None, None)
    authors = item.biblio.authors or []
    return {
        "item_id": item.id, "barcode": item.barcode, "title": item.biblio.title, "biblio_id": item.biblio_id,
        "author": authors[0] if authors else "", "call_number": item.call_number or "",
        "lines": split_call_number(item.call_number or item.biblio.classification, split_decimal=split_decimal),
        "library": item.branch.name, "branch_code": item.branch.code, "location": item.shelf_location or "",
        "barcode_svg": svg, "error": error,
    }


def patron_entry(p: Patron, library_name: str) -> dict:
    svg, error = _barcode_svg(p.card_number)
    return {
        "patron_id": p.id, "name": p.full_name, "card_number": p.card_number, "library": library_name,
        "branch": p.home_branch.name, "category": p.category.name, "initials": (p.first_name[:1] + p.last_name[:1]).upper(),
        "expires_on": p.expires_on.isoformat() if p.expires_on else None, "barcode_svg": svg, "error": error,
    }


# ------------------------------------------------------------------ batch selection


def parse_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list | tuple):
        parts = [str(v) for v in value]
    else:
        parts = re.split(r"[\s,;]+", str(value))
    return [p.strip() for p in parts if p and p.strip()]


def _int(value, default=None):
    try:
        return int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        raise DomainError(f"Expected a whole number, got {value!r}", code="validation_error") from None


def select_items(db: Session, params: Mapping) -> tuple[list[Item], list[str]]:
    source = params.get("source") or "barcodes"
    base = select(Item).where(Item.deleted_at.is_(None))
    if source == "barcodes":
        wanted = parse_list(params.get("barcodes"))[:MAX_LABELS]
        if not wanted:
            raise DomainError("Enter or scan at least one barcode", code="validation_error")
        found = {i.barcode: i for i in db.scalars(base.where(Item.barcode.in_(set(wanted))))}
        return [found[b] for b in wanted if b in found], [b for b in dict.fromkeys(wanted) if b not in found]
    if source == "recent":
        days = min(max(_int(params.get("days"), 7), 1), 3650)
        stmt = base.where(Item.created_at >= utcnow() - timedelta(days=days))
        if branch_id := _int(params.get("branch_id")):
            stmt = stmt.where(Item.branch_id == branch_id)
        return list(db.scalars(stmt.order_by(Item.created_at, Item.id).limit(MAX_LABELS))), []
    if source == "biblio":
        biblio_id = _int(params.get("biblio_id"))
        if not biblio_id:
            raise DomainError("Choose a record", code="validation_error")
        return list(db.scalars(base.where(Item.biblio_id == biblio_id).order_by(Item.id))), []
    raise DomainError(f"Unknown item source {source!r}", code="validation_error")


def select_patrons(db: Session, params: Mapping) -> list[Patron]:
    stmt = select(Patron).where(Patron.deleted_at.is_(None), Patron.is_active.is_(True))
    ids = [int(x) for x in parse_list(params.get("patron_ids")) if x.isdigit()]
    q = str(params.get("patron_q") or "").strip()
    category_id, branch_id = _int(params.get("category_id")), _int(params.get("branch_id"))
    if not (ids or q or category_id or branch_id or params.get("new_days")):
        raise DomainError("Search for patrons (name or card), or pick a category, branch or recent registrations",
                          code="validation_error")
    if ids:
        stmt = stmt.where(Patron.id.in_(ids))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Patron.card_number == q, Patron.last_name.ilike(like), Patron.first_name.ilike(like),
                              (Patron.first_name + " " + Patron.last_name).ilike(like)))
    if category_id:
        stmt = stmt.where(Patron.category_id == category_id)
    if branch_id:
        stmt = stmt.where(Patron.home_branch_id == branch_id)
    if new_days := _int(params.get("new_days")):
        stmt = stmt.where(Patron.created_at >= utcnow() - timedelta(days=min(max(new_days, 1), 3650)))
    return list(db.scalars(stmt.order_by(Patron.last_name, Patron.first_name).limit(MAX_LABELS)))


def build(db: Session, params: Mapping) -> dict:
    """Assemble a print job from request parameters (query string, form or JSON alike)."""
    kind = params.get("kind") or "item"
    if kind not in KINDS:
        raise DomainError("Kind must be spine, item or patron", code="validation_error")
    layout_id = _int(params.get("layout_id"))
    if layout_id:
        layout = get_layout(db, layout_id)
    else:
        ensure_presets(db)
        layout = db.scalar(select(LabelLayout).where(LabelLayout.kind == kind).order_by(LabelLayout.id))
        if layout is None:  # pragma: no cover - presets always cover every kind
            raise NotFound("No label layout available")
    copies = min(max(_int(params.get("copies"), 1), 1), 20)
    missing: list[str] = []
    if kind == "patron":
        library = settings_svc.get(db, "library_name")
        entries = [patron_entry(p, library) for p in select_patrons(db, params)]
    else:
        items, missing = select_items(db, params)
        split = str(params.get("split_decimal") or "").lower() in ("1", "true", "on", "yes")
        entries = [item_entry(i, kind, split_decimal=split) for i in items]
        if kind == "spine":
            for e in entries:
                e["font_size"] = fit_font(e["lines"], layout)
    entries = [e for e in entries for _ in range(copies)][:MAX_LABELS]
    start = min(max(_int(params.get("start"), 1), 1), layout.rows * layout.cols)
    pages = paginate(entries, layout.rows, layout.cols, start)
    cells = []
    for page in pages:
        out = []
        for idx, entry in enumerate(page):
            r, c = divmod(idx, layout.cols)
            out.append({"entry": entry, "row": r + 1, "col": c + 1,
                        "left": round(layout.margin_left + c * (layout.label_width + layout.gutter_x), 3),
                        "top": round(layout.margin_top + r * (layout.label_height + layout.gutter_y), 3)})
        cells.append(out)
    return {"kind": kind, "layout": layout_out(layout), "start": start, "copies": copies, "count": len(entries),
            "sheets": len(pages), "pages": cells, "missing": missing,
            "errors": [e for e in entries if e.get("error")], "generated_at": date.today().isoformat()}


def summary(job: dict, limit: int = 100) -> dict:
    """JSON-friendly preview of a job (no SVG payloads)."""
    rows = [cell["entry"] for page in job["pages"] for cell in page if cell["entry"]][:limit]
    trimmed = [{k: v for k, v in e.items() if k != "barcode_svg"} for e in rows]
    return {k: v for k, v in job.items() if k not in ("pages", "errors")} | {
        "entries": trimmed, "errors": [{"barcode": e.get("barcode") or e.get("card_number"), "error": e["error"]}
                                       for e in job["errors"]],
        "blank_cells": sum(1 for page in job["pages"] for cell in page if cell["entry"] is None)}
