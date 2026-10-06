from fastapi import APIRouter

from . import acquisitions, admin, ai, auth, catalog, circulation, opac, patrons, reports

api_router = APIRouter(prefix="/api/v1")
for module in (auth, catalog, patrons, circulation, opac, acquisitions, reports, admin, ai):
    api_router.include_router(module.router)

# ---- circulation services ----
from . import calendar as calendar_api  # noqa: E402
from . import hold_actions, notices, registration, suggestions  # noqa: E402

for module in (calendar_api, hold_actions, notices, registration, suggestions):
    api_router.include_router(module.router)
