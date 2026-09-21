"""Error reporting (Sentry) and the scrubbing hook that makes it safe.

Plan 0021 M2. This module is deliberately more scrubbing than SDK: the reason
error tracking took a week rather than an afternoon is that this service holds
things which must never reach a third party, and an error reporter's *default*
behaviour is to ship exactly those things.

Three defaults had to be turned off, not merely filtered:

`include_local_variables` is the load-bearing one. Sentry's Python SDK attaches
every stack frame's local variables to an event by default, and
`app/rag/queue.py::_process_code_file_job` binds the full text of a customer's
source file into `content`/`texts` while it chunks and embeds it. ADR 0011 is
an architectural promise that source code never rests in this system — no
`content` column on `CodeChunk`, only line ranges and vectors — and a reporter
with frame-local capture would convert that promise into a breach on the first
exception raised anywhere below that call. The same frames hold the decrypted
model key (`api_key`, same file) and the workspace GitHub PAT that
`integrations/github_auth.py::resolve_token` returns.

`max_request_body_size` defaults to capturing request bodies, which on this
service means uploaded PRDs and other customer documents (`api/documents.py`).
Set to "never".

`send_default_pii` is left explicitly False so the SDK does not attach cookies,
client IPs or user identity of its own accord.

On top of those, `before_send` is a deny-by-default pass over everything that
survives: request headers (`Authorization`, `X-User-Id`, webhook signatures),
breadcrumb payloads, `extra`, `contexts`, and any `vars` a future SDK version
or a hand-built event might still carry. Scrubbing is by key *name*, because
the values are exactly what we don't have in hand at scrub time.

Key-name scrubbing has a blind spot, and it is not hypothetical: **a secret
with no key of its own, sitting in a URL.** A security review of the first
cut of this module found two live ones.

`POST /invitations/{token}/accept` (`api/workspaces.py:261`) carries a
bearer-equivalent in its *path* — that token grants workspace membership to
whoever presents it — and `repo.accept_invitation` failing is an uncaught 500,
so the invitation URL lands in `event["request"]["url"]` verbatim. The
presence WebSocket (`api/presence.py:34`) takes the caller's Supabase JWT as
`?token=`, which lands in `event["request"]["query_string"]`. Neither is
reachable by a denylist of key names, because in both cases the key is
"url"/"query_string" and the secret is part of the value.

So `_sanitize_url` drops the query string and fragment from every URL-shaped
value and redacts any path segment sitting under a `_SECRET_PATH_PARENTS`
prefix, and `query_string` is popped outright. Path segments that are our own
ids (project, workspace, task) are deliberately left alone — they are the
same class of value as the tags below, and redacting them would leave a report
that cannot be tied to anything.

What is deliberately NOT scrubbed: `user_id` and `workspace_id`, which are set
as tags (`tag_user` / `tag_workspace` below). They are this system's own
identifiers, not credentials, and without them a report says only that
something failed.

With no DSN configured the SDK is never initialised at all — no network, no
patched frameworks, no cost. That is the default in dev and in tests; a
production instance without one is an operational fault warned about by
`Settings.require_production_safety()`.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import sentry_sdk
from sentry_sdk.integrations.argv import ArgvIntegration

logger = logging.getLogger("promptconnext")

_REDACTED = "[redacted]"

# Maximum nesting `_scrub` will walk before redacting wholesale. Sentry events
# are shallow; anything deeper is a pathological payload, not debugging value.
_MAX_DEPTH = 8

# Substrings matched (case-insensitively, `-`/`_` normalised) against dict keys
# and header names. Deny-by-default: a key whose name suggests a credential is
# redacted whether or not it actually holds one, because the alternative —
# an allowlist of known-safe keys — would silently admit every field added
# after this file was written.
#
# `x-user-id` is here not because the id is secret (it is a tag, see above)
# but because plan 0021 M2 names the header explicitly: in stub auth mode it
# *is* the credential, and a header that authenticates in one mode must not be
# reported in either.
_SENSITIVE_KEY_PARTS: tuple[str, ...] = (
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-user-id",
    "x-api-key",
    "x-hub-signature",
    "token",  # bearer tokens, the rate limiter's `tok:` identity, jira_api_token
    "secret",  # secret_ref, webhook secret, supabase_jwt_secret, client_secret
    "password",
    "passwd",
    "api-key",
    "apikey",
    "access-key",
    "private-key",
    "encryption-key",
    "credential",
    "signature",
    "session",
)


# A path segment immediately following one of these is a credential, not an
# identifier of ours, and is redacted by `_sanitize_url`. Keep this list
# narrow: over-redacting turns project and workspace ids — which are exactly
# what makes a report actionable — into noise.
_SECRET_PATH_PARENTS: frozenset[str] = frozenset(
    {
        "invitations",  # POST /invitations/{token}/accept — grants membership
        "invite",  # the web app's matching route shape
        "reset-password",
        "verify",
        "confirm",
    }
)

# Keys whose *value* is a URL. Scrubbing these by name would throw away the
# route, which is most of a report's value, so they get sanitised instead.
_URL_KEY_PARTS: tuple[str, ...] = ("url", "uri", "location", "referer", "referrer")

# Keys whose value is a query string or fragment — i.e. a URL's secret-bearing
# half with none of its useful half. Redacted outright.
#
# `http.query` is the one that matters and the one that is easy to miss: the
# ASGI integration records a breadcrumb per request carrying the raw query
# string under that key, so popping `request["query_string"]` alone still
# leaves the presence WebSocket's `?token=<JWT>` in the breadcrumb trail of
# every event captured afterwards in the same scope. Found by a test, not by
# reading the SDK.
_QUERY_KEY_PARTS: tuple[str, ...] = (
    "query",
    "querystring",
    "query-string",
    "fragment",
    "search",
)


def _normalise_key(key: str) -> str:
    """`_`, `.` and `-` are all the same separator for matching purposes, so
    `http.query`, `query_string` and `X-Api-Key` are all reachable."""
    return key.replace("_", "-").replace(".", "-").lower()


def _matches_key(key: Any, parts: tuple[str, ...]) -> bool:
    """Whole-name or dotted/underscored-suffix match — not a substring match,
    which would make `query` swallow `query_count`."""
    if not isinstance(key, str):
        return False
    normalised = _normalise_key(key)
    return any(normalised == part or normalised.endswith(f"-{part}") for part in parts)


def _is_sensitive_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalised = _normalise_key(key)
    return any(part in normalised for part in _SENSITIVE_KEY_PARTS) or _matches_key(
        key, _QUERY_KEY_PARTS
    )


def _is_url_key(key: Any) -> bool:
    return _matches_key(key, _URL_KEY_PARTS)


def _sanitize_url(url: Any) -> Any:
    """Keep scheme/host/path, drop the query and fragment, redact secret path
    segments.

    The query string is dropped wholesale rather than filtered: the presence
    WebSocket takes `?token=<Supabase JWT>`, and there is no query parameter
    on this service worth keeping at the price of having to enumerate every
    future one that isn't.
    """
    if not isinstance(url, str) or not url:
        return url
    try:
        split = urlsplit(url)
    except ValueError:
        return _REDACTED
    segments = split.path.split("/")
    for index in range(1, len(segments)):
        if segments[index] and segments[index - 1].lower() in _SECRET_PATH_PARENTS:
            segments[index] = _REDACTED
    return urlunsplit((split.scheme, split.netloc, "/".join(segments), "", ""))


def _scrub(value: Any, depth: int = 0) -> Any:
    """Recursively redact sensitive-looking keys in an arbitrary payload, and
    sanitise the URL-shaped values a key-name rule cannot see into."""
    if depth > _MAX_DEPTH:
        return _REDACTED
    if isinstance(value, dict):
        scrubbed: dict[Any, Any] = {}
        for key, item in value.items():
            if _is_sensitive_key(key):
                scrubbed[key] = _REDACTED
            elif _is_url_key(key):
                scrubbed[key] = _sanitize_url(item)
            else:
                scrubbed[key] = _scrub(item, depth + 1)
        return scrubbed
    if isinstance(value, list | tuple):
        return [_scrub(item, depth + 1) for item in value]
    return value


def _scrub_headers(headers: Any) -> Any:
    """Headers arrive as a dict from the Python SDK, but a hand-built event or
    a future SDK could use pair lists — handle both rather than assume."""
    if isinstance(headers, dict):
        return {
            name: (_REDACTED if _is_sensitive_key(name) else value)
            for name, value in headers.items()
        }
    if isinstance(headers, list | tuple):
        scrubbed = []
        for pair in headers:
            if isinstance(pair, list | tuple) and len(pair) == 2:
                name, value = pair
                scrubbed.append([name, _REDACTED if _is_sensitive_key(name) else value])
            else:
                scrubbed.append(_REDACTED)
        return scrubbed
    return headers


def _strip_frame_vars(event: dict) -> None:
    """Second line of defence behind `include_local_variables=False`.

    That option is what actually keeps a customer's source file out of an
    event; this loop exists so a future SDK default change, a hand-attached
    stacktrace, or an integration that builds frames itself cannot
    reintroduce frame locals without this hook noticing.
    """
    for container in ("exception", "threads"):
        values = (event.get(container) or {}).get("values") or []
        for value in values:
            if not isinstance(value, dict):
                continue
            frames = (value.get("stacktrace") or {}).get("frames") or []
            for frame in frames:
                if isinstance(frame, dict):
                    frame.pop("vars", None)
    # Older-shaped events put the stacktrace at the top level.
    for frame in (event.get("stacktrace") or {}).get("frames") or []:
        if isinstance(frame, dict):
            frame.pop("vars", None)


def before_send(event: dict, hint: dict | None = None) -> dict | None:
    """Drop everything this service must never send to a third party.

    Applied to every outbound event. The ordering is: frame locals first
    (source code, decrypted keys, PATs), then the request context Sentry
    attaches on its own (headers, body, cookies, environ, URL, query string),
    then a recursive key-name pass over the remaining free-form containers.
    """
    _strip_frame_vars(event)

    request = event.get("request")
    if isinstance(request, dict):
        # Uploaded document bodies (PRDs) and every other request payload.
        # `max_request_body_size="never"` should mean this is already absent;
        # popping it makes the guarantee independent of that option.
        request.pop("data", None)
        request.pop("cookies", None)
        # WSGI/ASGI environ carries the raw headers again, plus process env.
        request.pop("env", None)
        # `?token=<Supabase JWT>` on the presence WebSocket (api/presence.py).
        # Dropped, not filtered — see _sanitize_url's docstring.
        request.pop("query_string", None)
        if "headers" in request:
            request["headers"] = _scrub_headers(request["headers"])
        if "url" in request:
            # The invitation token in POST /invitations/{token}/accept lives in
            # the path, so this is the only thing that removes it.
            request["url"] = _sanitize_url(request["url"])

    # A log record reaches Sentry as three fields, and two of them carry the
    # interpolated arguments: `params` is the positional list and `formatted`
    # is the rendered string. Neither has a key name per argument, so the
    # pass below cannot see into either — `logger.error("tok=%s", tok)` would
    # ship `tok` twice over. Both go; `message`, the format string, is a
    # literal at every call site and stays.
    #
    # The cost is real and worth stating: a report from a log record now says
    # "embed job failed node=%s" rather than naming the node. That is the
    # price of not having to audit every future logging call in this service,
    # and it is a smaller loss than it looks — the event still carries the
    # stack trace, the logger name, and the `user_id`/`workspace_id` tags.
    # Anything else genuinely needed in a report should be attached
    # deliberately with `sentry_sdk.set_context`, where it is reviewable.
    logentry = event.get("logentry")
    if isinstance(logentry, dict):
        logentry.pop("params", None)
        logentry.pop("formatted", None)

    for container in ("breadcrumbs", "extra", "contexts", "tags", "user", "logentry"):
        if container in event:
            event[container] = _scrub(event[container])

    return event


def init_sentry(settings: Any, release: str | None = None, transport: Any = None) -> bool:
    """Initialise error reporting. Returns whether it was enabled.

    No DSN means no `sentry_sdk.init()` call at all — not an init with
    reporting switched off. Dev runs and the test suite take this path.

    `transport` is a test seam, the same shape as the `github_client` /
    `r2_client` overrides in app/main.py: substituting a transport is how
    tests/test_error_reporting.py asserts on what would actually leave this
    process, rather than re-declaring the option set and testing a copy of it.
    """
    dsn = getattr(settings, "sentry_dsn", None)
    if not dsn:
        return False

    sentry_sdk.init(
        dsn=dsn,
        transport=transport,
        environment=settings.app_env,
        release=release,
        # See the module docstring: this is the option that keeps a customer's
        # source file, their decrypted model key and their GitHub PAT out of
        # every stack frame we report.
        include_local_variables=False,
        # Never attach cookies, client IP or user identity automatically; the
        # only identity we send is the explicit tags below.
        send_default_pii=False,
        # Uploaded PRDs and document bodies are request payloads.
        max_request_body_size="never",
        before_send=before_send,
        # Errors only this milestone (plan 0021 M2 defers tracing to M3), so
        # `traces_sample_rate` is deliberately unset — passing 0.0 would still
        # switch the tracing machinery on. The transaction hook is wired
        # anyway so enabling tracing later cannot bypass the scrub.
        before_send_transaction=before_send,
        # ArgvIntegration puts the process command line in
        # `extra["sys.argv"]` as a positional list, which the key-name scrub
        # cannot see into. Nothing today puts a secret on argv — this service
        # is configured entirely through the environment, and the Dockerfile's
        # CMD is a bare uvicorn invocation — but "nothing does X today" is the
        # reasoning this whole module exists to avoid relying on, and the
        # command line is worth nothing diagnostically for a single-command
        # container.
        disabled_integrations=[ArgvIntegration()],
    )
    return True


def tag_user(user_id: str) -> None:
    """Tag the current request with the caller's id.

    Deliberately not scrubbed: it is our own identifier, and it is what turns
    "a 500 happened" into "this customer is blocked". Written to the *current
    isolation scope*, which the SDK's ASGI integration forks per request — so
    concurrent requests in this single-instance process do not see each
    other's tag. A no-op when reporting is off, which also means the scope is
    left untouched in dev and tests.
    """
    if sentry_sdk.is_initialized():
        sentry_sdk.set_tag("user_id", user_id)


def tag_workspace(workspace_id: str) -> None:
    """Tag the current request with the workspace it resolved to. Same
    per-request isolation and same rationale as `tag_user`."""
    if sentry_sdk.is_initialized():
        sentry_sdk.set_tag("workspace_id", workspace_id)
