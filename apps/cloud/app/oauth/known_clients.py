"""Redirect-URI based attribution of OAuth clients to known vendors."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class KnownClient:
    vendor: str
    redirect_hosts: frozenset[str]
    loopback: bool
    exact_uris: frozenset[str] = frozenset()


KNOWN: tuple[KnownClient, ...] = (
    KnownClient("Claude", frozenset({"claude.ai", "claude.com"}), True),
    KnownClient(
        "Cursor",
        frozenset({"www.cursor.com"}),
        True,
        frozenset({"cursor://anysphere.cursor-mcp/oauth/callback"}),
    ),
    KnownClient("ChatGPT", frozenset({"chatgpt.com"}), False),
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


def _host(uri: str) -> str | None:
    try:
        p = urlparse(uri)
        if p.scheme != "https" or p.username is not None or p.password is not None:
            return None
        return p.hostname
    except ValueError:
        return None


def classify(redirect_uris: list[str]) -> tuple[str | None, bool]:
    """Return (vendor, verified). All-loopback gives ("loopback", True)."""
    if not redirect_uris:
        return None, False
    if all(_is_loopback(u) for u in redirect_uris):
        return "loopback", True
    for client in KNOWN:
        if all(
            _is_loopback(u) and client.loopback
            or u in client.exact_uris
            or _host(u) in client.redirect_hosts
            for u in redirect_uris
        ):
            return client.vendor, True
    return None, False
