from fastapi import APIRouter

from . import (
    acquisitions,
    admin,
    ai,
    auth,
    catalog,
    circulation,
    hold_actions,
    notices,
    opac,
    patrons,
    registration,
    reports,
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
):
    api_router.include_router(module.router)
