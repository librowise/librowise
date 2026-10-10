"""Library policy settings: a deliberately small, typed and documented set."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..models import Setting

DEFAULTS: dict[str, tuple[Any, str]] = {
    "library_name": ("Librowise Public Library", "Name shown in the OPAC and notices"),
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
    # ---- circulation services ----
    "fines_skip_closed_days": (True, "Overdue fines count only days the issuing branch is open (library calendar)"),
    "allow_self_registration": (True, "Visitors may register for a library card on the OPAC (staff approve)"),
    "self_registration_category": ("ADULT", "Patron category code given to self-registered patrons"),
    "allow_purchase_suggestions": (True, "Patrons may suggest titles for purchase from the OPAC"),
    "notice_max_attempts": (5, "Delivery attempts before an outgoing notice is marked failed"),
}


# ---- presentation metadata for the Settings screen (additive; unknown keys fall back to sensible defaults)
# section: library profile · policies · notices · integrations (the Settings page's left navigation)
# group: a card inside the section · type: bool | int | str | text | select · unit: days | minutes | attempts
SECTIONS: tuple[str, ...] = ("profile", "policies", "notices", "integrations")

META: dict[str, dict[str, Any]] = {
    "library_name": {"section": "profile", "group": "identity", "label": "Library name", "type": "str",
                     "max_length": 120, "required": True},
    "opac_announcement": {"section": "profile", "group": "opac", "label": "Catalogue announcement", "type": "text",
                          "max_length": 500},
    "allow_patron_self_renewal": {"section": "policies", "group": "circulation", "label": "Patrons can renew online"},
    "auto_renew_when_no_holds": {"section": "policies", "group": "circulation", "label": "Automatic renewal"},
    "fines_skip_closed_days": {"section": "policies", "group": "circulation", "label": "No fines on closed days"},
    "allow_self_registration": {"section": "policies", "group": "opac", "label": "Online card registration"},
    "self_registration_category": {"section": "policies", "group": "opac", "label": "Category for new registrations",
                                   "type": "select", "options": "categories"},
    "allow_purchase_suggestions": {"section": "policies", "group": "opac", "label": "Purchase suggestions"},
    "allow_reviews": {"section": "policies", "group": "opac", "label": "Ratings and reviews"},
    "reviews_require_approval": {"section": "policies", "group": "opac", "label": "Approve reviews before publishing"},
    "anonymize_history_after_days": {"section": "policies", "group": "privacy", "label": "Anonymise loan history after",
                                     "unit": "days", "min": 0, "max": 36500},
    "require_2fa_for_staff": {"section": "policies", "group": "security", "label": "Require two-factor sign-in for staff"},
    "lockout_threshold": {"section": "policies", "group": "security", "label": "Lock accounts after failed sign-ins",
                          "unit": "attempts", "min": 0, "max": 100},
    "lockout_minutes": {"section": "policies", "group": "security", "label": "Lockout duration",
                        "unit": "minutes", "min": 1, "max": 1440},
    "session_idle_timeout_minutes": {"section": "policies", "group": "security", "label": "Sign out idle sessions after",
                                     "unit": "minutes", "min": 0, "max": 10080},
    "notify_new_signin": {"section": "policies", "group": "security", "label": "Alert on sign-in from a new device"},
    "password_reset_enabled": {"section": "policies", "group": "security", "label": "Self-service password reset"},
    "authority_auto_link": {"section": "policies", "group": "cataloguing", "label": "Link headings to authorities automatically"},
    "notice_max_attempts": {"section": "notices", "group": "delivery", "label": "Delivery attempts per notice",
                            "unit": "attempts", "min": 1, "max": 50},
    "ai_assistant_enabled": {"section": "integrations", "group": "ai", "label": "Staff AI copilot"},
    "ai_opac_enabled": {"section": "integrations", "group": "ai", "label": "AI search in the public catalogue"},
}


def _type_of(default: Any) -> str:
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, int):
        return "int"
    if isinstance(default, float):
        return "float"
    return "str"


def describe(key: str) -> dict[str, Any]:
    """Presentation metadata for one setting: section, group, label, type, unit and limits."""
    default, _desc = DEFAULTS[key]
    meta = {"section": "policies", "group": "other", "label": key.replace("_", " ").capitalize(),
            "type": _type_of(default), "unit": None, "min": None, "max": None, "options": None,
            "max_length": None, "required": False}
    meta.update(META.get(key, {}))
    return meta


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is not None:
        return row.value
    return DEFAULTS.get(key, (None, ""))[0]


def all_settings(db: Session) -> list[dict]:
    stored = {s.key: s.value for s in db.query(Setting).all()}
    return [
        {"key": k, "value": stored.get(k, default), "default": default, "description": desc, **describe(k)}
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
