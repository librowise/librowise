"""Per-client rate limiting for the public protocol endpoints (SRU, OAI-PMH)."""

from __future__ import annotations

import os

from fastapi import HTTPException, Request

from ..security import SlidingWindowLimiter

limiter = SlidingWindowLimiter(int(os.environ.get("SHELFWISE_PROTOCOL_REQUESTS_PER_MINUTE", "300")))


def check_rate(request: Request, scope: str) -> None:
    ip = request.client.host if request.client else "unknown"
    if not limiter.allow(f"{scope}:{ip}"):
        # 503 + Retry-After is what OAI-PMH harvesters expect for flow control.
        raise HTTPException(503, "Too many requests; please slow down", headers={"Retry-After": "60"})
