"""Staff shell support: the notification centre feed.

``GET /api/v1/ui/notifications`` aggregates what needs a librarian's attention, filtered by the caller's
permissions: dashboard alerts (overdue spikes, budgets, hold queues), holds waiting on the shelf, failed
patron notices, pending self-registrations and purchase suggestions, and — for administrators — failed
background jobs. Each item has a stable ``id`` that changes when its content changes, so the browser can
remember what was read (per user, in localStorage) without any server-side state.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..models import (
    Hold,
    HoldStatus,
    Job,
    Notification,
    Patron,
    PatronRegistration,
    PurchaseSuggestion,
    SuggestionStatus,
    utcnow,
)
from ..security import has_permission

router = APIRouter(prefix="/ui", tags=["ui"])

_ALERT_TONE = {"bad": "danger", "warn": "warning"}
_ALERT_ICON = {"overdue_spike": "trend", "budget": "wallet", "holds_ratio": "bookmark", "failed_notices": "send"}


@router.get("/notifications")
def notifications(db: Session = Depends(get_db), user: Patron = Depends(require("catalog:read"))):
    now = utcnow()
    today = now.date().isoformat()
    items: list[dict] = []

    def add(id_: str, kind: str, tone: str, icon: str, title: str, body: str, href: str, params: dict | None = None):
        items.append({"id": id_, "kind": kind, "tone": tone, "icon": icon, "title": title, "body": body, "href": href,
                      "params": params or {}, "at": now})

    if has_permission(user, "reports:read"):
        from ..services import analytics

        for a in analytics.alerts(db, None, now=now):
            if a["kind"] == "failed_notices":
                continue  # reported below with its own permission
            key = a.get("biblio_id") or a["params"].get("name") or ""
            add(f"alert:{a['kind']}:{key}:{a['value']}:{today}", a["kind"], _ALERT_TONE.get(a["level"], "info"),
                _ALERT_ICON.get(a["kind"], "alert"), a["message"], "", a["href"], a["params"])

    if has_permission(user, "holds:manage"):
        ready = db.scalar(select(func.count()).select_from(Hold).where(Hold.status == HoldStatus.ready)) or 0
        if ready:
            expiring = db.scalar(select(func.count()).select_from(Hold).where(
                Hold.status == HoldStatus.ready, Hold.expires_at.is_not(None), Hold.expires_at <= now + timedelta(days=2))) or 0
            add(f"holds_ready:{today}:{ready}:{expiring}", "holds_ready", "info", "bookmark",
                f"{ready} hold(s) waiting on the hold shelf", f"{expiring} expire within two days." if expiring else "",
                "/staff/holds", {"count": ready, "expiring": expiring})

    if has_permission(user, "notices:outbox"):
        failed = db.scalar(select(func.count()).select_from(Notification).where(
            Notification.status == "failed", Notification.created_at >= now - timedelta(days=7))) or 0
        if failed:
            add(f"notices_failed:{today}:{failed}", "notices_failed", "danger", "send",
                f"{failed} patron notice(s) failed to send", "In the last 7 days.", "/staff/notices", {"count": failed})

    if has_permission(user, "patrons:approve"):
        pending = db.scalar(select(func.count()).select_from(PatronRegistration).where(PatronRegistration.status == "pending")) or 0
        if pending:
            add(f"registrations:{pending}", "registrations", "info", "user-plus",
                f"{pending} self-registration(s) awaiting approval", "", "/staff/requests", {"count": pending})

    if has_permission(user, "suggestions:manage"):
        pending = db.scalar(select(func.count()).select_from(PurchaseSuggestion).where(PurchaseSuggestion.status == SuggestionStatus.pending)) or 0
        if pending:
            add(f"suggestions:{pending}", "suggestions", "info", "cart",
                f"{pending} purchase suggestion(s) to review", "", "/staff/requests#suggestions", {"count": pending})

    if has_permission(user, "jobs:manage"):
        since = now - timedelta(hours=24)
        failed_jobs = db.scalar(select(func.count()).select_from(Job).where(
            Job.status.in_(("failed", "dead")), Job.finished_at.is_not(None), Job.finished_at >= since)) or 0
        if failed_jobs:
            add(f"jobs_failed:{today}:{failed_jobs}", "jobs_failed", "danger", "activity",
                f"{failed_jobs} background job(s) failed", "In the last 24 hours.", "/staff/system", {"count": failed_jobs})

    order = {"danger": 0, "warning": 1, "info": 2, "success": 3}
    items.sort(key=lambda i: order.get(i["tone"], 9))
    return {"generated_at": now, "items": items}
