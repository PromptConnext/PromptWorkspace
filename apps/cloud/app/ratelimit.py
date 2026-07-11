"""Token-bucket rate limiting for sync + webhook endpoints (M4/M7).

A chatty client (auto-sync polling, a webhook storm) must not exhaust the
backend. We apply a per-identity token bucket on the hot write/poll paths.
Identity is the authenticated user when available, else the client host, so an
unauthenticated webhook flood is still bounded by source.

Single-process, in-memory. Horizontal scale needs a shared store (Redis); this
is flagged for the same follow-up as presence fan-out.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

# Prefixes that count against the limit. Reads of the whole graph and the cheap
# /changes probe both live under /sync; webhooks under /api/webhooks. Chat
# (M9) is metered separately by cost too (app/rag/budget.py) but still counts
# against the request-throughput bucket like every other hot path.
_LIMITED_PREFIXES = ("/sync", "/api/webhooks")
_LIMITED_SUFFIXES = ("/assistant/chat",)


@dataclass
class _Bucket:
    tokens: float
    updated: float


@dataclass
class TokenBucketLimiter:
    """Refills `per_minute` tokens/minute up to `burst` capacity."""

    per_minute: int
    burst: int
    _buckets: dict[str, _Bucket] = field(default_factory=dict)

    def allow(self, key: str, now: float) -> bool:
        rate = self.per_minute / 60.0
        bucket = self._buckets.get(key)
        if bucket is None:
            self._buckets[key] = _Bucket(tokens=self.burst - 1, updated=now)
            return True
        elapsed = max(0.0, now - bucket.updated)
        bucket.tokens = min(self.burst, bucket.tokens + elapsed * rate)
        bucket.updated = now
        if bucket.tokens < 1.0:
            return False
        bucket.tokens -= 1.0
        return True


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, limiter: TokenBucketLimiter) -> None:
        super().__init__(app)
        self._limiter = limiter

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        limited = path.startswith(_LIMITED_PREFIXES) or path.endswith(_LIMITED_SUFFIXES)
        if not limited:
            return await call_next(request)
        key = _identity(request)
        if not self._limiter.allow(key, time.monotonic()):
            retry = max(1, round(60 / max(1, self._limiter.per_minute)))
            return JSONResponse(
                {"detail": "rate_limited"},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        return await call_next(request)


def _identity(request: Request) -> str:
    uid = request.headers.get("x-user-id")
    if uid:
        return f"user:{uid}"
    auth = request.headers.get("authorization")
    if auth:
        # Key by a stable suffix of the bearer token; avoids storing the token.
        return f"tok:{auth[-24:]}"
    client = request.client
    return f"ip:{client.host if client else 'unknown'}"
