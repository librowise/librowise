from fastapi import APIRouter

from . import acquisitions, admin, ai, auth, catalog, circulation, opac, patrons, reports
from . import courses as courses_api  # serials & course reserves
from . import serials as serials_api

api_router = APIRouter(prefix="/api/v1")
for module in (auth, catalog, patrons, circulation, opac, acquisitions, reports, admin, ai):
    api_router.include_router(module.router)
for module in (serials_api, courses_api):
    api_router.include_router(module.router)
