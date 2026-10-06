from fastapi import APIRouter

from . import account_security, acquisitions, admin, ai, auth, catalog, circulation, opac, patrons, reports, roles, sso

api_router = APIRouter(prefix="/api/v1")
for module in (auth, catalog, patrons, circulation, opac, acquisitions, reports, admin, ai):
    api_router.include_router(module.router)
# identity & access
for module in (account_security, roles, sso):
    api_router.include_router(module.router)
