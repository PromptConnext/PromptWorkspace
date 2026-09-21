"""A request id that survives the whole path, and JSON log lines to carry it.

Plan 0021 M3. Two halves of one question — *which request was that?* — and
neither is useful without the other: an id nothing prints is invisible, and a
plain-text line Railway's log search can only substring-match is not a field.

**The id.** `RequestIdMiddleware` reads `X-Request-Id` from the incoming
request or mints a UUID, binds it to a contextvar for the duration of the
request, echoes it back on the response under the same header, and tags the
Sentry scope with it (see `app/observability.py::tag_request`) so an error
report and the log lines around it name the same value. `apps/web`'s `apiFetch`
sends one per call, which is what lets "it failed at 14:32" become a grep.

The incoming header is untrusted input that ends up in a log line, so a value
that isn't a short token of `[A-Za-z0-9._:-]` is *replaced* by a minted id
rather than sanitised in place: a client that puts a newline in the header
would otherwise get to forge whole log records, and quietly mangling the value
it sent would be worse than ignoring it.

**Where the middleware sits.** Plain ASGI rather than `BaseHTTPMiddleware`, and
registered last in `create_app` so it is the *outermost* user middleware
(Starlette's `add_middleware` prepends, and the first entry is the outer one).
That matters three times over: the rate limiter's 429 gets an id like any other
response; `BaseHTTPMiddleware` runs the rest of the stack in a child task,
which copies the context at spawn time, so the binding has to happen *outside*
it to be visible inside; and Sentry's ASGI integration wraps the application
above all user middleware, having already forked the isolation scope, so a tag
set here lands on this request's scope and is attached to any exception
captured below it.

**The lines.** `configure_logging` installs a stdlib `Formatter` subclass that
emits one JSON object per record and a filter that reads the contextvar onto
every record. No dependency: the plan's stated cost for this milestone is "one
middleware and one dataclass field, and adds no dependency", and a
`json.dumps` in `format()` keeps that promise. Records emitted outside any
request — startup, the tombstone GC, an embed job enqueued by a backfill —
carry `"request_id": null`, which is a true statement about them rather than a
missing field.

Deliberately *not* here: tracing. The plan defers OpenTelemetry until a second
service exists, so there is no span, no propagation format and no sampling
decision in this file — `X-Request-Id` is echoed, and nothing else.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

from app.observability import tag_request

REQUEST_ID_HEADER = "X-Request-Id"

_HEADER_NAME_BYTES = REQUEST_ID_HEADER.lower().encode("ascii")

_request_id: ContextVar[str | None] = ContextVar("promptconnext_request_id", default=None)

# What a client is allowed to choose for itself. Long enough for a UUID or a
# proxy's own id, restricted to characters that cannot break a log line, an
# HTTP header or a shell grep.
_ACCEPTABLE_ID = re.compile(r"\A[A-Za-z0-9._:-]{1,200}\Z")

# httpx's HTTP/2 stack logs every frame and HPACK header at DEBUG, which
# drowns out our own records when LOG_LEVEL=DEBUG. Pinned to WARNING.
_NOISY_LOGGERS = ("hpack", "h2", "httpcore", "httpx")


def new_request_id() -> str:
    return str(uuid.uuid4())


def get_request_id() -> str | None:
    """The id of the request being served on this task, or None outside one."""
    return _request_id.get()


@contextmanager
def request_id_scope(request_id: str | None) -> Iterator[str | None]:
    """Bind an id (or explicitly nothing) for the duration of the block.

    Used by the middleware per request and by `embed_worker_loop` per job. The
    reset is not decoration: the worker is one long-lived task, so an id left
    bound would label the *next* job with the previous job's request.
    """
    token = _request_id.set(request_id)
    try:
        yield request_id
    finally:
        _request_id.reset(token)


def _incoming_request_id(headers: Any) -> str:
    """The client's id if it is one we are willing to print, else a fresh one."""
    for name, value in headers or ():
        if name.lower() != _HEADER_NAME_BYTES:
            continue
        try:
            candidate = value.decode("latin-1").strip()
        except (AttributeError, UnicodeDecodeError):
            break
        if _ACCEPTABLE_ID.match(candidate):
            return candidate
        break
    return new_request_id()


class RequestIdFilter(logging.Filter):
    """Puts the current request id on every record passing through a handler.

    A filter rather than a `LoggerAdapter` or an `extra=` at each call site,
    because the point is that records this service does not own — uvicorn's,
    a library's, an `except` in a route nobody edited — carry it too.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = get_request_id()
        return True


class JsonLogFormatter(logging.Formatter):
    """One JSON object per line: timestamp, level, logger, message, request id.

    `request_id` is always present and null outside a request, so a log search
    can filter on the field rather than on a substring of a rendered line.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", None),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        # `default=str` so a record whose `%s` argument is an exotic object
        # degrades to its repr instead of making logging itself raise.
        return json.dumps(payload, default=str)


def configure_logging(level: str) -> None:
    """Root logging: JSON lines carrying the request id.

    `basicConfig` without `force=True` on purpose. It is a no-op when the root
    logger already has handlers, which is the same behaviour this call had
    before M3 — and under pytest those handlers belong to the `caplog` plugin,
    so forcing them out would break every test that asserts on a startup
    warning.
    """
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())
    handler.addFilter(RequestIdFilter())
    logging.basicConfig(level=level, handlers=[handler])
    for noisy in _NOISY_LOGGERS:
        logging.getLogger(noisy).setLevel(logging.WARNING)


class RequestIdMiddleware:
    """Bind an id for the request, echo it on the response.

    See the module docstring for why this is plain ASGI and why it must be the
    outermost *user* middleware.

    One response shape the echo cannot reach, and it is worth naming rather
    than discovering: Starlette adds `ServerErrorMiddleware` above every user
    middleware, so the bare 500 it synthesises for an *unhandled* exception is
    sent outside this wrapper and carries no header. Handled responses — every
    `HTTPException`, the rate limiter's 429, a 404 — pass through it normally,
    and an unhandled 500 is still correlated by the `request_id` Sentry tag set
    below and by the log lines the handler emitted before it raised. Catching
    the exception here to send our own 500 would put this file in charge of
    error-response semantics (debug tracebacks, registered handlers) to add a
    header, which is the wrong trade.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope.get("headers"))
        with request_id_scope(request_id):
            tag_request(request_id)
            if scope.get("type") != "http":
                # A WebSocket handshake response has no place to put it, but
                # the binding still covers everything the socket's handler
                # logs (app/api/presence.py).
                await self.app(scope, receive, send)
                return

            async def send_with_request_id(message: dict) -> None:
                if message.get("type") == "http.response.start":
                    headers = list(message.get("headers") or [])
                    if not any(name.lower() == _HEADER_NAME_BYTES for name, _ in headers):
                        headers.append((_HEADER_NAME_BYTES, request_id.encode("ascii")))
                        message["headers"] = headers
                await send(message)

            await self.app(scope, receive, send_with_request_id)
