"""ASGI application factory."""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .api import api_router
from .config import BASE_DIR, get_settings
from .db import create_all, get_engine
from .errors import DomainError
from .security import CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, csrf_valid
from .web import router as web_router

log = logging.getLogger("shelfwise")

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_EXEMPT = {"/api/v1/auth/login", "/api/v1/auth/logout",
               # pre-authentication steps (no session yet; protected by single-use tokens / rate limits)
               "/api/v1/auth/mfa", "/api/v1/auth/password-reset", "/api/v1/auth/password-reset/confirm"}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; "
    "worker-src 'self'; manifest-src 'self'"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_all()
    log.info("Shelfwise %s ready", __version__)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = FastAPI(
        title=settings.app_name,
        version=__version__,
        description="Modern, AI-assisted integrated library system. OpenAPI 3.1, JSON everywhere.",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    @app.middleware("http")
    async def security_and_timing(request: Request, call_next):
        start = time.perf_counter()
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        path = request.url.path
        if (
            request.method in UNSAFE_METHODS
            and path.startswith("/api/")
            and path not in CSRF_EXEMPT
            and not request.headers.get("authorization", "").lower().startswith("bearer ")
            and request.cookies.get(SESSION_COOKIE)
            and not csrf_valid(request.cookies.get(CSRF_COOKIE), request.headers.get(CSRF_HEADER))
        ):
            return JSONResponse({"detail": "CSRF token missing or invalid", "code": "csrf"}, status_code=403)
        response = await call_next(request)
        elapsed = (time.perf_counter() - start) * 1000
        response.headers["X-Request-ID"] = request_id
        response.headers["Server-Timing"] = f"app;dur={elapsed:.1f}"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
        if not path.startswith("/api/docs") and not path.startswith("/api/redoc"):
            response.headers["Content-Security-Policy"] = CSP
        if settings.cookie_secure:
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        if path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        elif path.startswith("/static/"):
            # ES modules are imported by bare URL, so always revalidate (cheap 304s via ETag).
            response.headers["Cache-Control"] = "no-cache"
        if elapsed > 500:
            log.warning("slow request %s %s %.0fms id=%s", request.method, path, elapsed, request_id)
        return response

    app.add_middleware(GZipMiddleware, minimum_size=1024)
    if settings.allowed_hosts != ["*"]:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    if settings.cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                           allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(DomainError)
    async def domain_error(_: Request, exc: DomainError):
        return JSONResponse({"detail": exc.message, "code": exc.code, **exc.details}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        errors = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
        msg = "; ".join(f"{e['field']}: {e['message']}" for e in errors[:3])
        return JSONResponse({"detail": msg or "Invalid request", "code": "validation_error", "errors": errors},
                            status_code=422)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return {"status": "ok", "version": __version__}

    @app.get("/readyz", include_in_schema=False)
    def readyz():
        try:
            with get_engine().connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception:  # pragma: no cover
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return {"status": "ready"}

    app.include_router(api_router)
    app.include_router(web_router)
    app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
    return app


app = create_app()
