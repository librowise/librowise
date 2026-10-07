"""Analytics API: date-ranged, branch-filterable panels for the staff Analytics page, plus the
operational snapshot behind the staff dashboard. Every panel is also exportable as CSV."""

from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..models import Branch, Patron
from ..services import analytics as svc

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _window(db: Session, start: date | None, end: date | None, granularity: str, branch_id: int | None) -> svc.Window:
    if branch_id is not None and db.get(Branch, branch_id) is None:
        raise HTTPException(422, "Unknown branch")
    try:
        return svc.make_window(start, end, granularity, branch_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


def _csv(name: str, table: dict) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(table["headers"])
    for row in table["rows"]:
        # neutralise spreadsheet formula injection
        w.writerow([f"'{c}" if isinstance(c, str) and c[:1] in "=+-@" else c for c in row])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="shelfwise-{name}.csv"'})


@router.get("/dashboard")
def dashboard(branch_id: int | None = Query(default=None, ge=1), db: Session = Depends(get_db),
              _: Patron = Depends(require("reports:read"))):
    """Staff home snapshot: KPIs with 7-day deltas and sparklines, today's desk work, and alerts."""
    if branch_id is not None and db.get(Branch, branch_id) is None:
        raise HTTPException(422, "Unknown branch")
    return svc.dashboard(db, branch_id)


@router.get("/panels")
def panels(_: Patron = Depends(require("analytics:read"))):
    return {"panels": list(svc.PANELS), "granularities": list(svc.GRANULARITIES), "max_range_days": svc.MAX_RANGE_DAYS}


@router.get("/{panel}")
def panel(panel: str, start: date | None = None, end: date | None = None,
          granularity: str = Query(default="day", pattern="^(day|week|month)$"),
          branch_id: int | None = Query(default=None, ge=1),
          fmt: str = Query(default="json", pattern="^(json|csv)$"),
          db: Session = Depends(get_db), _: Patron = Depends(require("analytics:read"))):
    """One analytics panel for an inclusive, library-local date range (default: the last 30 days)."""
    fn = svc.PANELS.get(panel)
    if fn is None:
        raise HTTPException(404, "Unknown analytics panel")
    w = _window(db, start, end, granularity, branch_id)
    data = fn(db, w)
    if fmt == "csv":
        return _csv(f"{panel}-{w.start.isoformat()}-{w.end.isoformat()}", data["table"])
    return {"panel": panel, "range": {"start": w.start, "end": w.end, "days": w.days, "granularity": w.granularity,
                                       "branch_id": w.branch_id, "previous_start": w.previous().start,
                                       "previous_end": w.previous().end, "utc_offset_minutes": w.offset_minutes},
            **data}
