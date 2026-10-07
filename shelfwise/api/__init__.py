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
