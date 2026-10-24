"""OAuth client resolution and redirect-URI matching.

Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
`GET /oauth/authorize`. A `redirect_uri` must equal a registered one exactly,
except loopback (RFC 8252 §7.3): `http://localhost` and `http://127.0.0.1`
match on any port, with the same scheme, host and path. Hosts are compared on
the *parsed* hostname, never by string prefix, so `http://localhost.evil.com`
and `http://localhost@evil.com` are not loopback.

One non-https, non-loopback URI is allowed, by exact string match only:
Cursor's native callback `cursor://anysphere.cursor-mcp/oauth/callback`,
which its DCR payload registers and redirects to. Never a `cursor:` scheme
wildcard: any other `cursor://` URI is refused.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from urllib.parse import SplitResult, urlsplit

from app.models.schemas import OAuthClient, utcnow

LOOPBACK_HOSTS = ("localhost", "127.0.0.1")
CIMD_REFRESH = timedelta(seconds=3600)
CURSOR_NATIVE_CALLBACK = "cursor://anysphere.cursor-mcp/oauth/callback"
# Exact strings only; see the module docstring.
NATIVE_CALLBACKS = frozenset({CURSOR_NATIVE_CALLBACK})


class RedirectError(ValueError):
    """The candidate redirect URI matches no registered one."""


class UnknownClient(LookupError):
    """No stored client and the id is not a CIMD URL."""


def _split(url: object) -> SplitResult | None:
    try:
        parts = urlsplit(str(url))
        parts.port  # noqa: B018 - raises ValueError on a malformed port
        return parts
    except ValueError:
        return None


def is_loopback(url: object) -> bool:
    """`http` with hostname exactly `localhost` or `127.0.0.1`, no userinfo."""
    p = _split(url)
    return (
        p is not None
        and p.scheme.lower() == "http"
        and p.hostname in LOOPBACK_HOSTS
        and p.username is None
        and p.password is None
    )


def redirect_uri_allowed(url: object) -> bool:
    """A redirect URI a client may register: loopback, `https` with a host,
    no userinfo and no fragment, or exactly one of `NATIVE_CALLBACKS`."""
    if isinstance(url, str) and url in NATIVE_CALLBACKS:
        return True
    p = _split(url)
    if p is None or p.fragment or "#" in str(url):
        return False
    if is_loopback(url):
        return True
    return (
        p.scheme.lower() == "https"
        and bool(p.hostname)
        and p.username is None
        and p.password is None
    )


def validate_redirect_uri(candidate: str, registered: list[str]) -> str:
    """Return the registered URI `candidate` matches; raise `RedirectError`.
    A candidate that could not be registered today never matches, so a stored
    row can't widen the allowed set (e.g. to another `cursor://` URI)."""
    if not redirect_uri_allowed(candidate):
        raise RedirectError("redirect_uri is not an allowed redirect URI")
    if candidate in registered:
        return candidate
    if is_loopback(candidate):
        c = _split(candidate)
        assert c is not None
        for reg in registered:
            if not is_loopback(reg):
                continue
            r = _split(reg)
            assert r is not None
            if (
                c.scheme.lower() == r.scheme.lower()
                and c.hostname == r.hostname
                and c.path == r.path
                and c.query == r.query
                and not c.fragment
                and not r.fragment
            ):
                return reg
    raise RedirectError("redirect_uri does not match a registered redirect URI")


def _cimd_stale(client: OAuthClient, now: datetime) -> bool:
    """A stored CIMD row older than an hour (or with no usable `fetched_at`)."""
    raw = (client.metadata or {}).get("fetched_at")
    try:
        fetched = datetime.fromisoformat(raw) if isinstance(raw, str) else None
    except ValueError:
        fetched = None
    if fetched is None or fetched.tzinfo is None:
        return True
    return now - fetched > CIMD_REFRESH


async def resolve_client(
    repo,
    client_id: str,
    *,
    cimd_fetch: Callable[[str], Awaitable[OAuthClient]],
) -> OAuthClient:
    """The stored client, else a CIMD fetched and stored as `kind="cimd"`,
    else `UnknownClient`. A stored CIMD row whose `metadata["fetched_at"]` is
    over an hour old is refetched (and upserted) first, so a client's edits to
    its document (e.g. a removed redirect URI) take effect. A stored, fresh
    client is only read: this runs on every unauthenticated authorize call,
    so `last_used_at` moves at approve and at token issue instead.
    `cimd_fetch` errors (`CimdError`) propagate."""
    now = utcnow()
    stored = repo.get_oauth_client(client_id)
    if stored is not None and not (stored.kind == "cimd" and _cimd_stale(stored, now)):
        return stored
    if client_id.lower().startswith("https://"):
        fetched = await cimd_fetch(client_id)
        # `fetched_at` is ours: written after the document, so a document
        # cannot declare itself fresh forever.
        metadata = {**(fetched.metadata or {}), "fetched_at": now.isoformat()}
        update = {"kind": "cimd", "last_used_at": now, "metadata": metadata}
        if stored is not None:
            update["created_at"] = stored.created_at
        fetched = fetched.model_copy(update=update)
        return repo.upsert_oauth_client(fetched)
    raise UnknownClient(client_id)
