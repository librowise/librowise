"""Library policy settings: a deliberately small, typed and documented set."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..models import Setting

DEFAULTS: dict[str, tuple[Any, str]] = {
    "library_name": ("Shelfwise Public Library", "Name shown in the OPAC and notices"),
    "opac_announcement": ("", "Banner message shown on the public catalogue"),
    "allow_patron_self_renewal": (True, "Patrons may renew their own loans from the OPAC"),
    "allow_reviews": (True, "Patrons may rate and review titles"),
    "reviews_require_approval": (False, "New reviews are hidden until approved by staff"),
    "anonymize_history_after_days": (
        365,
        "Detach patrons from returned loans older than this (0 = never). Privacy by default.",
    ),
    "auto_renew_when_no_holds": (False, "Nightly job auto-renews loans without pending holds"),
    "ai_assistant_enabled": (True, "Show the AI copilot to staff"),
    "ai_opac_enabled": (True, "Allow natural-language search and recommendations in the OPAC"),
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is not None:
        return row.value
    return DEFAULTS.get(key, (None, ""))[0]


def all_settings(db: Session) -> list[dict]:
    stored = {s.key: s.value for s in db.query(Setting).all()}
    return [
        {"key": k, "value": stored.get(k, default), "default": default, "description": desc}
        for k, (default, desc) in DEFAULTS.items()
    ]


def set_value(db: Session, key: str, value: Any) -> None:
    if key not in DEFAULTS:
        raise KeyError(key)
    default = DEFAULTS[key][0]
    if isinstance(default, bool):
        value = bool(value)
    elif isinstance(default, int):
        value = int(value)
    elif isinstance(default, str):
        value = str(value)
    row = db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value, description=DEFAULTS[key][1]))
    else:
        row.value = value
