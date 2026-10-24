"""Token-bucket rate limiting for sync + webhook endpoints (M4/M7).

A chatty client (auto-sync polling, a webhook storm) must not exhaust the
backend. We apply a per-identity token bucket on the hot write/poll paths.
Identity is the authenticated user when available, else the client host, so an
unauthenticated webhook flood is still bounded by source.

Single-process, in-memory. Horizontal scale needs a shared store (Redis); this
is flagged for the same follow-up as presence fan-out.
"""

from __future__ import annotations

import inspect
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import parse_qs

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

# Prefixes that count against the limit. Reads of the whole graph and the cheap
# /changes probe both live under /sync; webhooks under /api/webhooks (and the
# LINE webhook under /integrations/line, a path fixed in the LINE console). Chat
# (M9) is metered separately by cost too (app/rag/budget.py) but still counts
# against the request-throughput bucket like every other hot path.
_LIMITED_PREFIXES = ("/sync", "/api/webhooks", "/desktop-auth", "/integrations/line")
_LIMITED_SUFFIXES = ("/assistant/chat",)


@dataclass
class _Bucket:
    tokens: float
    updated: float


@dataclass
class TokenBucketLimiter:
    """Refills `per_minute` tokens/minute up to `burst` capacity."""

    per_minute: float
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


class CompositeLimiter:
    """Passes only if every member passes. Each member is `(limiter, key_fn)`
    where `key_fn` maps the rule's key to that member's bucket key (a constant
    for a global bucket). Members are checked in order and short-circuit."""

    def __init__(self, members: list[tuple[TokenBucketLimiter, Callable[[str], str]]]) -> None:
        self._members = members
        self.per_minute = min(m.per_minute for m, _ in members)

    def allow(self, key: str, now: float) -> bool:
        return all(limiter.allow(kf(key), now) for limiter, kf in self._members)


Key = Callable[[Request], "str | Awaitable[str]"]


@dataclass
class LimitRule:
    name: str
    match: Callable[[Request], bool]
    key: Key
    limiter: TokenBucketLimiter | CompositeLimiter


class RateLimitMiddleware(BaseHTTPMiddleware):
    """The first rule whose `match` is true applies; no match passes through."""

    def __init__(self, app, rules: list[LimitRule]) -> None:
        super().__init__(app)
        self._rules = rules

    async def dispatch(self, request: Request, call_next):
        for rule in self._rules:
            if not rule.match(request):
                continue
            key = rule.key(request)
            if inspect.isawaitable(key):
                key = await key
            if not rule.limiter.allow(key, time.monotonic()):
                retry = max(1, round(60 / max(rule.limiter.per_minute, 1e-9)))
                return JSONResponse(
                    {"detail": "rate_limited"},
                    status_code=429,
                    headers={"Retry-After": str(retry)},
                )
            break
        return await call_next(request)


def identity(request: Request, *, stub_mode: bool) -> str:
    # X-User-Id is client-supplied; it is only an identity in stub auth mode.
    if stub_mode:
        uid = request.headers.get("x-user-id")
        if uid:
            return f"user:{uid}"
    auth = request.headers.get("authorization")
    if auth:
        # Key by a stable suffix of the bearer token; avoids storing the token.
        return f"tok:{auth[-24:]}"
    client = request.client
    return f"ip:{client.host if client else 'unknown'}"


def _ip(request: Request) -> str:
    client = request.client
    return f"ip:{client.host if client else 'unknown'}"


_MAX_FORM_BYTES = 16 * 1024


async def _token_client_key(request: Request) -> str:
    cid = request.query_params.get("client_id")
    if not cid and request.headers.get("content-type", "").startswith(
        "application/x-www-form-urlencoded"
    ):
        # Unknown (absent / non-numeric) length means unbounded: never buffer it.
        try:
            length = int(request.headers.get("content-length", ""))
        except ValueError:
            length = None
        too_big = length is None or length > _MAX_FORM_BYTES
        if not too_big:
            # BaseHTTPMiddleware replays a body read here to the route.
            form = parse_qs((await request.body()).decode("utf-8", "replace"))
            cid = (form.get("client_id") or [""])[0]
    return f"client:{cid}" if cid else _ip(request)


def _hourly(rate: int, burst: int) -> TokenBucketLimiter:
    return TokenBucketLimiter(per_minute=rate / 60, burst=burst)


def default_rules(settings) -> list[LimitRule]:
    stub_mode = settings.auth_mode == "stub"

    def ident(request: Request) -> str:
        return identity(request, stub_mode=stub_mode)

    def is_api(request: Request) -> bool:
        path = request.url.path
        return path.startswith(_LIMITED_PREFIXES) or path.endswith(_LIMITED_SUFFIXES)

    return [
        LimitRule(
            "oauth_register",
            lambda r: r.method == "POST" and r.url.path == "/oauth/register",
            _ip,
            CompositeLimiter(
                [
                    (_hourly(30, 5), lambda k: k),
                    (_hourly(300, 30), lambda k: "all"),
                ]
            ),
        ),
        LimitRule(
            "oauth_authorize_cimd",
            lambda r: (
                r.method == "GET"
                and r.url.path == "/oauth/authorize"
                and r.query_params.get("client_id", "").lower().startswith("https://")
            ),
            _ip,
            _hourly(20, 5),
        ),
        LimitRule(
            "oauth_token",
            lambda r: r.method == "POST" and r.url.path == "/oauth/token",
            _token_client_key,
            TokenBucketLimiter(per_minute=60, burst=20),
        ),
        LimitRule(
            "mcp",
            lambda r: r.url.path == "/mcp" or r.url.path.startswith("/mcp/"),
            ident,
            TokenBucketLimiter(per_minute=300, burst=60),
        ),
        LimitRule(
            "api",
            is_api,
            ident,
            TokenBucketLimiter(
                per_minute=settings.rate_limit_per_minute, burst=settings.rate_limit_burst
            ),
        ),
    ]
