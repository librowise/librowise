from fastapi import APIRouter

from . import (
    account_security,
    acquisitions,
    admin,
    ai,
    auth,
    catalog,
    circulation,
    hold_actions,
    interop,
    notices,
    opac,
    patrons,
    registration,
    reports,
    roles,
    sso,
    suggestions,
)
from . import calendar as calendar_api
from . import courses as courses_api
from . import serials as serials_api

api_router = APIRouter(prefix="/api/v1")
for module in (
    auth, catalog, patrons, circulation, opac, acquisitions, reports, admin, ai,
    # circulation services
    calendar_api, hold_actions, notices, registration, suggestions,
    # serials & course reserves
    serials_api, courses_api,
    # identity & access
    account_security, roles, sso,
    # interoperability
    interop,
):
    api_router.include_router(module.router)

# ---- experience: analytics, self-checkout kiosk, discovery
from . import analytics, discovery, kiosk  # noqa: E402

for module in (analytics, kiosk, discovery):
    api_router.include_router(module.router)

# ---- platform & operations ----
from . import system  # noqa: E402

api_router.include_router(system.router)

# ---- cataloguing ----
from . import authorities, batch_items, labels, marc_editor  # noqa: E402

for module in (authorities, marc_editor, labels, batch_items):
    api_router.include_router(module.router)

# ---- design system: staff shell notifications, cover uploads ----
from . import covers, ui  # noqa: E402

for module in (ui, covers):
    api_router.include_router(module.router)
