"""OAuth client resolution and redirect-URI matching.

Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
`GET /oauth/authorize`. A `redirect_uri` must equal a registered one exactly,
except loopback (RFC 8252 §7.3): `http://localhost` and `http://127.0.0.1`
match on any port, with the same scheme, host and path. Hosts are compared on
the *parsed* hostname, never by string prefix, so `http://localhost.evil.com`
and `http://localhost@evil.com` are not loopback.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from urllib.parse import SplitResult, urlsplit

from app.models.schemas import OAuthClient, utcnow

LOOPBACK_HOSTS = ("localhost", "127.0.0.1")


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
    """A redirect URI a client may register: loopback, or `https` with a host,
    no userinfo and no fragment."""
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
    """Return the registered URI `candidate` matches; raise `RedirectError`."""
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


async def resolve_client(
    repo,
    client_id: str,
    *,
    cimd_fetch: Callable[[str], Awaitable[OAuthClient]],
) -> OAuthClient:
    """The stored client (its `last_used_at` bumped), else a CIMD fetched and
    stored as `kind="cimd"`, else `UnknownClient`. `cimd_fetch` errors
    (`CimdError`) propagate."""
    stored = repo.get_oauth_client(client_id)
    if stored is not None:
        stored.last_used_at = utcnow()
        return repo.upsert_oauth_client(stored)
    if client_id.lower().startswith("https://"):
        fetched = await cimd_fetch(client_id)
        fetched = fetched.model_copy(update={"kind": "cimd", "last_used_at": utcnow()})
        return repo.upsert_oauth_client(fetched)
    raise UnknownClient(client_id)
