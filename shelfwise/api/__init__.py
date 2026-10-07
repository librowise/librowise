from fastapi import APIRouter

from . import acquisitions, admin, ai, auth, catalog, circulation, opac, patrons, reports

api_router = APIRouter(prefix="/api/v1")
for module in (auth, catalog, patrons, circulation, opac, acquisitions, reports, admin, ai):
    api_router.include_router(module.router)

# ---- cataloguing ----
from . import authorities, batch_items, labels, marc_editor  # noqa: E402

for module in (authorities, marc_editor, labels, batch_items):
    api_router.include_router(module.router)
