"""Redirect-URI based attribution of OAuth clients to known vendors.

A client is attributed to a vendor (and shown as Verified on the consent
page) only when every redirect URI it registered is one of that vendor's
exact callback URIs, or loopback for vendors whose desktop clients use one.
Exact strings, never hosts or prefixes: a host match would mark any path on
the vendor's domain, including ones the vendor does not control as a
callback, as verified."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class KnownClient:
    vendor: str
    redirect_uris: frozenset[str]
    loopback: bool


KNOWN: tuple[KnownClient, ...] = (
    KnownClient(
        "Claude",
        frozenset(
            {
                "https://claude.ai/api/mcp/auth_callback",
                "https://claude.com/api/mcp/auth_callback",
            }
        ),
        True,
    ),
    KnownClient(
        "Cursor",
        frozenset(
            {
                "https://www.cursor.com/agents/mcp/oauth/callback",
                "cursor://anysphere.cursor-mcp/oauth/callback",
            }
        ),
        True,
    ),
    KnownClient(
        "ChatGPT",
        frozenset({"https://chatgpt.com/connector_platform_oauth_redirect"}),
        False,
    ),
)


def _is_loopback(uri: str) -> bool:
    try:
        p = urlparse(uri)
        return (
            p.scheme == "http"
            and p.hostname in ("localhost", "127.0.0.1")
            and p.username is None
            and p.password is None
        )
    except ValueError:
        return False


def classify(redirect_uris: list[str]) -> tuple[str | None, bool]:
    """Return (vendor, verified). All-loopback gives ("loopback", True)."""
    if not redirect_uris:
        return None, False
    if all(_is_loopback(u) for u in redirect_uris):
        return "loopback", True
    for client in KNOWN:
        if all(
            u in client.redirect_uris or (client.loopback and _is_loopback(u))
            for u in redirect_uris
        ):
            return client.vendor, True
    return None, False
