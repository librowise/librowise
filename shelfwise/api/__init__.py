from fastapi import APIRouter

from . import acquisitions, admin, ai, auth, catalog, circulation, opac, patrons, reports

api_router = APIRouter(prefix="/api/v1")
for module in (auth, catalog, patrons, circulation, opac, acquisitions, reports, admin, ai):
    api_router.include_router(module.router)
