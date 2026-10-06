"""Permission catalogue and built-in role permission sets.

Every API endpoint is guarded by one permission string (``deps.require("...")``). Built-in roles map
to fixed sets below; administrators can additionally define custom :class:`~shelfwise.models.StaffRole`
rows whose permissions are *added* to the built-in set (effective = built-in ∪ custom).
``*`` (administrators only) grants everything, including permissions added by future modules.
"""

from __future__ import annotations

from .models import Role

ALL = "*"

# (code, group, description). Order is the display order in the admin UI.
CATALOGUE: list[tuple[str, str, str]] = [
    ("opac", "Self-service", "Use the public catalogue and manage one's own account"),
    ("catalog:read", "Cataloguing", "View staff catalogue, items and lookup tables"),
    ("catalog:write", "Cataloguing", "Create and edit records and items"),
    ("catalog:delete", "Cataloguing", "Delete bibliographic records and items"),
    ("authorities:manage", "Cataloguing", "Manage authority records"),
    ("circulation", "Circulation", "Check out, check in, renew, receive transfers, take payments"),
    ("circulation:override", "Circulation", "Override circulation blocks (limits, fines, expiry, renewals)"),
    ("holds:manage", "Circulation", "Place, cancel and manage holds for patrons"),
    ("fines:charge", "Circulation", "Add manual charges to patron accounts"),
    ("fines:waive", "Circulation", "Waive (forgive) patron charges"),
    ("patrons:read", "Patrons", "View patron records"),
    ("patrons:write", "Patrons", "Register and edit patrons"),
    ("patrons:delete", "Patrons", "Erase patron records (GDPR erasure)"),
    ("patrons:manage_staff", "Patrons", "Manage staff accounts, custom roles and their access"),
    ("acquisitions:read", "Acquisitions", "View vendors, budgets and orders"),
    ("acquisitions:write", "Acquisitions", "Create vendors, budgets and orders; receive orders"),
    ("serials:manage", "Acquisitions", "Manage serial subscriptions and issues"),
    ("courses:manage", "Course reserves", "Manage course reserves"),
    ("notices:manage", "Notices", "Manage notice templates and the message queue"),
    ("reports:read", "Reports", "Run reports and view dashboards"),
    ("reports:export", "Reports", "Export report data (CSV)"),
    ("ai:staff", "Reports", "Use the staff AI copilot"),
    ("settings:manage", "Administration", "Change system settings, security policy and single sign-on"),
    ("audit:read", "Administration", "Read the audit log"),
    ("jobs:manage", "Administration", "Run and schedule background jobs"),
    ("sip:manage", "Administration", "Manage SIP2 / self-check accounts"),
    ("admin", "Administration", "Full administration of lookup tables, imports and maintenance"),
]

PERMISSION_CODES: frozenset[str] = frozenset(code for code, _, _ in CATALOGUE)

_LIBRARIAN = {
    "opac", "catalog:read", "catalog:write", "catalog:delete", "authorities:manage",
    "circulation", "circulation:override", "holds:manage", "fines:charge", "fines:waive",
    "patrons:read", "patrons:write", "patrons:delete",
    "acquisitions:read", "acquisitions:write", "serials:manage", "courses:manage", "notices:manage",
    "reports:read", "reports:export", "ai:staff",
}

BUILTIN_ROLE_PERMISSIONS: dict[Role, set[str]] = {
    Role.patron: {"opac"},
    Role.librarian: _LIBRARIAN,
    Role.admin: {ALL},
}


def grouped() -> list[dict]:
    """Catalogue grouped for display: ``[{group, permissions: [{code, description}]}]``."""
    groups: dict[str, list[dict]] = {}
    for code, group, description in CATALOGUE:
        groups.setdefault(group, []).append({"code": code, "description": description})
    return [{"group": g, "permissions": perms} for g, perms in groups.items()]


def describe(code: str) -> str:
    for c, _, description in CATALOGUE:
        if c == code:
            return description
    return code
