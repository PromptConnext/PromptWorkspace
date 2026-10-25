"""SSRF-safe fetch of OAuth Client ID Metadata Documents (CIMD).

Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
"Security". The `client_id` URL must be `https` on port 443 with no userinfo.
Its hostname is resolved once; every resolved address (IPv4-mapped and NAT64
forms unwrapped to the embedded IPv4) must be public, and the request is sent
to a checked address as an IP-literal URL with the original hostname in the
`Host` header and as the TLS SNI name (`sni_hostname` request extension, which
httpcore also uses for certificate hostname verification). A second DNS answer
therefore cannot swap the address after the check (DNS rebinding). If an
address refuses the connection, the next checked one is tried (IPv4 first),
never an address that was not checked. Redirects
are refused, the whole fetch is capped at 10 s, the body at 64 KB, and results
are cached per `client_id` for an hour.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from urllib.parse import urlsplit

import httpx

from app.models.schemas import OAuthClient, utcnow
from app.oauth.clients import redirect_uri_allowed

MAX_BYTES = 65_536
MAX_URI = 2048
MAX_SCOPE = 1000
TIMEOUT_SECONDS = 10.0
CACHE_TTL = timedelta(seconds=3600)

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
# Refused explicitly: the stdlib's is_global does not cover these on every
# Python version (carrier-grade NAT; deprecated 6to4 relay anycast).
_REFUSED_V4 = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("192.88.99.0/24"),
)

Resolver = Callable[[str, int], Awaitable[list]]


class CimdError(ValueError):
    """`code` is one of: not_https, bad_port, private_address, too_large,
    timeout, invalid_document, client_id_mismatch."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def check_address(ip: str) -> None:
    """Raise `CimdError("private_address")` unless `ip` is a public address."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        raise CimdError("private_address", f"unparseable address {ip!r}") from None
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        elif addr in _NAT64:
            addr = ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
    if (
        not addr.is_global
        or addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
        or (addr.version == 4 and any(addr in n for n in _REFUSED_V4))
        or (addr.version == 6 and addr.is_site_local)
    ):
        raise CimdError("private_address", f"{ip} is not a public address")


async def _default_resolver(host: str, port: int) -> list:
    loop = asyncio.get_running_loop()
    return await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def _address(entry) -> str:
    """The IP string from a getaddrinfo 5-tuple (or a bare string)."""
    if isinstance(entry, str):
        return entry
    return str(entry[4][0])


def _is_json(content_type: str) -> bool:
    media = content_type.split(";", 1)[0].strip().lower()
    return media == "application/json" or media.endswith("+json")


def _to_client(client_id: str, doc: object, now: datetime) -> OAuthClient:
    if not isinstance(doc, dict):
        raise CimdError("invalid_document", "document is not a JSON object")
    if doc.get("client_id") != client_id:
        raise CimdError("client_id_mismatch", "document client_id differs from its URL")
    uris = doc.get("redirect_uris")
    if (
        not isinstance(uris, list)
        or not uris
        or not all(isinstance(u, str) and redirect_uri_allowed(u) for u in uris)
    ):
        raise CimdError("invalid_document", "redirect_uris must list https or loopback URIs")
    if doc.get("token_endpoint_auth_method", "none") != "none":
        raise CimdError("invalid_document", "only public clients are supported")

    now_iso = now.isoformat()
    return OAuthClient(
        client_id=client_id,
        kind="cimd",
        client_name=_text(doc.get("client_name"), 120) or "",
        redirect_uris=list(uris),
        client_uri=_https_uri(doc.get("client_uri")),
        logo_uri=_https_uri(doc.get("logo_uri")),
        metadata=_allow_listed(doc, now_iso),
        created_at=now,
    )


def _text(v: object, cap: int) -> str | None:
    return v[:cap] if isinstance(v, str) else None


def _https_uri(v: object) -> str | None:
    """`v` if it is an https URL with a host, no userinfo and at most
    `MAX_URI` characters; otherwise None. Shown on the consent page, so
    `javascript:`/`data:` and the like must never get through."""
    if not isinstance(v, str) or len(v) > MAX_URI:
        return None
    try:
        p = urlsplit(v)
        p.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError:
        return None
    if p.scheme.lower() != "https" or not p.hostname:
        return None
    if p.username is not None or p.password is not None:
        return None
    return v


def _str_list(v: object, max_items: int, cap: int) -> list[str] | None:
    if not isinstance(v, list):
        return None
    return [s[:cap] for s in v[:max_items] if isinstance(s, str)]


def _allow_listed(doc: dict, fetched_at: str) -> dict:
    """The same keys DCR stores, length-capped, plus `fetched_at`. The full
    document is never persisted."""
    return {
        "application_type": _text(doc.get("application_type"), 20),
        "grant_types": _str_list(doc.get("grant_types"), 10, 64),
        "response_types": _str_list(doc.get("response_types"), 10, 64),
        "scope": _text(doc.get("scope"), MAX_SCOPE),
        "fetched_at": fetched_at,
    }


async def _get(url: str, host: str, transport: httpx.AsyncBaseTransport) -> bytes:
    async with httpx.AsyncClient(
        transport=transport, follow_redirects=False, timeout=TIMEOUT_SECONDS
    ) as client:
        async with client.stream(
            "GET",
            url,
            headers={
                "Host": host,
                "Accept": "application/json",
                "Accept-Encoding": "identity",
            },
            extensions={"sni_hostname": host},
        ) as resp:
            if resp.is_redirect or 300 <= resp.status_code < 400:
                raise CimdError("invalid_document", "redirects are not followed")
            if resp.status_code != 200:
                raise CimdError("invalid_document", f"status {resp.status_code}")
            if not _is_json(resp.headers.get("content-type", "")):
                raise CimdError("invalid_document", "not application/json")
            encoding = resp.headers.get("content-encoding", "").strip().lower()
            if encoding not in ("", "identity"):
                # The cap counts bytes on the wire; a compressed body could
                # expand far past it, so only identity is accepted.
                raise CimdError("invalid_document", f"content-encoding {encoding!r}")
            declared = resp.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_BYTES:
                raise CimdError("too_large", "document over 64 KB")
            body = bytearray()
            async for chunk in resp.aiter_raw():
                body += chunk
                if len(body) > MAX_BYTES:
                    raise CimdError("too_large", "document over 64 KB")
            return bytes(body)


async def fetch_client_metadata(
    client_id: str,
    *,
    now: datetime | None = None,
    cache: dict,
    resolver: Resolver | None = None,
    transport_factory: Callable[[], httpx.AsyncBaseTransport] | None = None,
) -> OAuthClient:
    now = now or utcnow()
    hit = cache.get(client_id)
    if hit is not None and now - hit[0] < CACHE_TTL:
        return hit[1].model_copy(deep=True)

    try:
        parts = urlsplit(client_id)
        port = parts.port
    except ValueError:
        raise CimdError("not_https", "client_id is not a valid URL") from None
    host = parts.hostname
    if parts.scheme.lower() != "https" or not host:
        raise CimdError("not_https", "client_id must be an https URL")
    if parts.username is not None or parts.password is not None or parts.fragment:
        raise CimdError("not_https", "client_id must not carry userinfo or a fragment")
    if port not in (None, 443):
        raise CimdError("bad_port", "client_id must use port 443")

    resolve = resolver or _default_resolver
    try:
        entries = await asyncio.wait_for(resolve(host, 443), TIMEOUT_SECONDS)
    except TimeoutError:
        raise CimdError("timeout", "DNS resolution timed out") from None
    except OSError:
        raise CimdError("invalid_document", "hostname does not resolve") from None
    addresses = [_address(e) for e in entries or ()]
    if not addresses:
        raise CimdError("invalid_document", "hostname does not resolve")
    for ip in addresses:
        check_address(ip)

    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    # IPv4 first (many hosts publish AAAA records this server cannot reach),
    # otherwise in resolver order; dict.fromkeys drops duplicates.
    ordered = sorted(dict.fromkeys(addresses), key=lambda ip: ":" in ip)

    async def attempt() -> bytes:
        for i, ip in enumerate(ordered):
            literal = f"[{ip}]" if ":" in ip else ip
            transport = (
                transport_factory() if transport_factory else httpx.AsyncHTTPTransport(retries=0)
            )
            try:
                return await _get(f"https://{literal}{path}", host, transport)
            except httpx.ConnectError:
                # Only a failure to connect moves on: once an address answers,
                # its answer is final.
                if i == len(ordered) - 1:
                    raise
        raise AssertionError("unreachable")  # pragma: no cover

    try:
        raw = await asyncio.wait_for(attempt(), TIMEOUT_SECONDS)
    except (TimeoutError, httpx.TimeoutException):
        raise CimdError("timeout", "metadata fetch timed out") from None
    except httpx.HTTPError as exc:
        raise CimdError("invalid_document", f"fetch failed: {type(exc).__name__}") from None

    try:
        doc = json.loads(raw)
    except (ValueError, RecursionError):
        raise CimdError("invalid_document", "body is not JSON") from None
    client = _to_client(client_id, doc, now)
    cache[client_id] = (now, client.model_copy(deep=True))
    return client
