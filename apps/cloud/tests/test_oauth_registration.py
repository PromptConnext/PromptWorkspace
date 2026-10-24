"""Client registration: DCR (`POST /oauth/register`), redirect-URI matching,
client resolution and SSRF-safe CIMD fetches. Hermetic: CIMD fetches run
against `httpx.MockTransport` and a fake resolver."""

from __future__ import annotations

import json
import socket
from datetime import timedelta

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db.repository import InMemoryRepository
from app.main import create_app
from app.models.schemas import OAuthClient, utcnow
from app.oauth.cimd import CimdError, check_address, fetch_client_metadata
from app.oauth.clients import (
    RedirectError,
    UnknownClient,
    is_loopback,
    resolve_client,
    validate_redirect_uri,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MCP_ENABLED", "1")
    monkeypatch.setenv("MCP_OAUTH_SIGNING_KEY", _pem())
    monkeypatch.setenv("PUBLIC_API_URL", "https://api.test/")
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


# --------------------------------------------------------------------------- #
# DCR
# --------------------------------------------------------------------------- #


def test_dcr_happy_path_stores_client(client):
    body = {
        "redirect_uris": [
            "http://localhost:8787/callback",
            "https://www.cursor.com/agents/mcp/oauth/callback",
        ],
        "client_name": "Cursor",
        "client_uri": "https://www.cursor.com",
        "application_type": "native",
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }
    r = client.post("/oauth/register", json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["redirect_uris"] == body["redirect_uris"]
    assert out["client_name"] == "Cursor"
    assert out["token_endpoint_auth_method"] == "none"
    assert out["grant_types"] == ["authorization_code", "refresh_token"]
    assert out["response_types"] == ["code"]
    assert isinstance(out["client_id_issued_at"], int)
    assert "client_secret" not in out
    stored = client.app.state.repository.get_oauth_client(out["client_id"])
    assert stored is not None
    assert stored.kind == "dcr"
    assert stored.redirect_uris == body["redirect_uris"]
    assert stored.client_uri == "https://www.cursor.com"


def test_dcr_defaults_grant_and_response_types(client):
    r = client.post("/oauth/register", json={"redirect_uris": ["http://127.0.0.1/cb"]})
    assert r.status_code == 201, r.text
    assert r.json()["grant_types"] == ["authorization_code", "refresh_token"]
    assert r.json()["response_types"] == ["code"]
    assert r.json()["client_name"] == ""


@pytest.mark.parametrize(
    "uri",
    [
        "http://example.com/callback",
        "http://localhost.evil.com/callback",
        "http://localhost@evil.com/",
        "https://user@example.com/cb",
        "https://example.com/cb#frag",
        "myapp://callback",
        "not a url",
    ],
)
def test_dcr_refuses_bad_redirect(client, uri):
    r = client.post("/oauth/register", json={"redirect_uris": [uri]})
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_redirect_uri"
    assert r.json()["error_description"]


@pytest.mark.parametrize(
    "patch",
    [
        {"token_endpoint_auth_method": "client_secret_basic"},
        {"redirect_uris": [f"https://a.example/{i}" for i in range(11)]},
        {"redirect_uris": []},
        {"grant_types": ["client_credentials"]},
        {"response_types": ["token"]},
        {"client_name": "x" * 121},
        {"application_type": "desktop"},
        {"client_uri": "javascript:alert(1)"},
    ],
)
def test_dcr_refuses_bad_metadata(client, patch):
    body = {"redirect_uris": ["https://a.example/cb"], **patch}
    r = client.post("/oauth/register", json=body)
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "invalid_client_metadata"


@pytest.mark.parametrize("raw", [b"not json", b"[1,2]", b'{"client_name": "x"}'])
def test_dcr_refuses_malformed_body(client, raw):
    r = client.post(
        "/oauth/register", content=raw, headers={"content-type": "application/json"}
    )
    assert r.status_code == 400
    assert r.json()["error"] in ("invalid_client_metadata", "invalid_redirect_uri")


# --------------------------------------------------------------------------- #
# Redirect URI matching (Review Focus 1)
# --------------------------------------------------------------------------- #


def test_is_loopback():
    assert is_loopback("http://localhost/callback")
    assert is_loopback("http://127.0.0.1:3000/cb")
    assert is_loopback("http://LOCALHOST/cb")
    assert not is_loopback("https://localhost/cb")
    assert not is_loopback("http://localhost.evil.com/callback")
    assert not is_loopback("http://localhost@evil.com/")
    assert not is_loopback("http://evil@localhost/")
    assert not is_loopback("http://127.0.0.1.evil.com/")
    assert not is_loopback("http://[::1]/cb")


def test_redirect_exact_match():
    reg = ["https://claude.ai/api/mcp/auth_callback"]
    assert validate_redirect_uri(reg[0], reg) == reg[0]
    with pytest.raises(RedirectError):
        validate_redirect_uri("https://claude.ai/api/mcp/auth_callback/", reg)
    with pytest.raises(RedirectError):
        validate_redirect_uri("https://claude.ai:8443/api/mcp/auth_callback", reg)


def test_redirect_loopback_any_port():
    reg = ["http://localhost/callback"]
    assert validate_redirect_uri("http://localhost:9999/callback", reg) == reg[0]
    reg2 = ["http://127.0.0.1:1234/cb"]
    assert validate_redirect_uri("http://127.0.0.1:5555/cb", reg2) == reg2[0]


@pytest.mark.parametrize(
    "candidate",
    [
        "http://localhost.evil.com/callback",
        "http://localhost@evil.com/",
        "http://localhost@evil.com/callback",
        "http://localhost:9999/other",
        "http://127.0.0.1:9999/callback",
        "https://localhost:9999/callback",
        "http://localhost:9999/callback?x=1",
    ],
)
def test_redirect_loopback_refusals(candidate):
    with pytest.raises(RedirectError):
        validate_redirect_uri(candidate, ["http://localhost/callback"])


# --------------------------------------------------------------------------- #
# resolve_client
# --------------------------------------------------------------------------- #


def _client(cid: str, kind: str = "dcr") -> OAuthClient:
    return OAuthClient(
        client_id=cid, kind=kind, redirect_uris=["https://a.example/cb"], created_at=utcnow()
    )


@pytest.mark.anyio
async def test_resolve_stored_wins_and_bumps_last_used():
    repo = InMemoryRepository()
    repo.upsert_oauth_client(_client("abc"))

    async def boom(_):  # pragma: no cover - must not be called
        raise AssertionError("fetched")

    got = await resolve_client(repo, "abc", cimd_fetch=boom)
    assert got.client_id == "abc"
    assert repo.get_oauth_client("abc").last_used_at is not None


@pytest.mark.anyio
async def test_resolve_cimd_fetches_and_upserts():
    repo = InMemoryRepository()
    url = "https://client.example/meta.json"
    calls = []

    async def fetch(cid):
        calls.append(cid)
        return _client(cid, kind="cimd")

    got = await resolve_client(repo, url, cimd_fetch=fetch)
    assert calls == [url]
    assert got.kind == "cimd"
    assert repo.get_oauth_client(url).kind == "cimd"


@pytest.mark.anyio
async def test_resolve_unknown():
    async def fetch(cid):  # pragma: no cover
        raise AssertionError

    with pytest.raises(UnknownClient):
        await resolve_client(InMemoryRepository(), "nope", cimd_fetch=fetch)
    with pytest.raises(UnknownClient):
        await resolve_client(InMemoryRepository(), "http://x.example/m", cimd_fetch=fetch)


# --------------------------------------------------------------------------- #
# check_address (Review Focus 2)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "::1",
        "::ffff:10.0.0.1",
        "::ffff:127.0.0.1",
        "169.254.169.254",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "fd00::1",
        "fe80::1",
        "0.0.0.0",
        "::",
        "100.64.0.1",
        "224.0.0.1",
        "ff02::1",
        "240.0.0.1",
        "64:ff9b::a00:1",
        "64:ff9b::a9fe:a9fe",
        "garbage",
    ],
)
def test_check_address_refuses(ip):
    with pytest.raises(CimdError) as e:
        check_address(ip)
    assert e.value.code == "private_address"


@pytest.mark.parametrize(
    "ip", ["93.184.216.34", "2606:4700:4700::1111", "::ffff:93.184.216.34", "64:ff9b::5db8:d822"]
)
def test_check_address_allows_public(ip):
    check_address(ip)


# --------------------------------------------------------------------------- #
# fetch_client_metadata
# --------------------------------------------------------------------------- #

CID = "https://client.example/oauth/meta.json"
PUBLIC = "93.184.216.34"


def _resolver(*ips, calls=None):
    async def resolve(host, port):
        if calls is not None:
            calls.append((host, port))
        out = []
        for ip in ips:
            fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
            out.append((fam, socket.SOCK_STREAM, 6, "", (ip, port)))
        return out

    return resolve


def _doc(**over):
    d = {
        "client_id": CID,
        "client_name": "Claude Code",
        "client_uri": "https://claude.ai",
        "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"],
        "token_endpoint_auth_method": "none",
    }
    d.update(over)
    return d


class _RawStream(httpx.AsyncByteStream):
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def __aiter__(self):
        for i in range(0, len(self._data), 4096):
            yield self._data[i : i + 4096]


def _transport(handler, seen=None):
    """A real transport hands back an unread stream; `httpx.Response(content=...)`
    reads itself on construction, so re-wrap its raw (still encoded) bytes."""

    def wrapped(request: httpx.Request):
        if seen is not None:
            seen.append(request)
        r = handler(request)
        if isinstance(r.stream, httpx.ByteStream):
            return httpx.Response(
                r.status_code, headers=r.headers, stream=_RawStream(b"".join(r.stream))
            )
        return r

    return lambda: httpx.MockTransport(wrapped)


def _json_handler(doc):
    return lambda req: httpx.Response(200, json=doc)


@pytest.mark.anyio
async def test_fetch_happy_path_pins_ip_and_keeps_hostname():
    seen: list[httpx.Request] = []
    got = await fetch_client_metadata(
        CID,
        cache={},
        resolver=_resolver(PUBLIC),
        transport_factory=_transport(_json_handler(_doc()), seen),
    )
    assert got.kind == "cimd"
    assert got.client_id == CID
    assert got.client_name == "Claude Code"
    assert got.client_uri == "https://claude.ai"
    assert got.redirect_uris == ["http://localhost/callback", "http://127.0.0.1/callback"]
    assert "client_id" not in got.metadata
    assert "fetched_at" in got.metadata
    (req,) = seen
    assert req.url.host == PUBLIC
    assert req.url.scheme == "https"
    assert req.url.path == "/oauth/meta.json"
    assert req.headers["host"] == "client.example"
    assert req.extensions["sni_hostname"] == "client.example"


@pytest.mark.anyio
async def test_fetch_ipv6_literal_url():
    seen: list[httpx.Request] = []
    await fetch_client_metadata(
        CID,
        cache={},
        resolver=_resolver("2606:4700:4700::1111"),
        transport_factory=_transport(_json_handler(_doc()), seen),
    )
    assert seen[0].url.host == "2606:4700:4700::1111"
    assert seen[0].headers["host"] == "client.example"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "ips", [("127.0.0.1",), ("::ffff:10.0.0.1",), (PUBLIC, "169.254.169.254"), ("::1",)]
)
async def test_fetch_private_address_refused_before_connect(ips):
    seen: list[httpx.Request] = []
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID,
            cache={},
            resolver=_resolver(*ips),
            transport_factory=_transport(_json_handler(_doc()), seen),
        )
    assert e.value.code == "private_address"
    assert seen == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("cid", "code"),
    [
        ("http://client.example/m.json", "not_https"),
        ("https://client.example:8443/m.json", "bad_port"),
        ("https://user@client.example/m.json", "not_https"),
    ],
)
async def test_fetch_url_refusals(cid, code):
    calls: list = []
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            cid,
            cache={},
            resolver=_resolver(PUBLIC, calls=calls),
            transport_factory=_transport(_json_handler(_doc(client_id=cid))),
        )
    assert e.value.code == code
    assert calls == []


@pytest.mark.anyio
async def test_fetch_explicit_443_allowed():
    cid = "https://client.example:443/m.json"
    got = await fetch_client_metadata(
        cid,
        cache={},
        resolver=_resolver(PUBLIC),
        transport_factory=_transport(_json_handler(_doc(client_id=cid))),
    )
    assert got.client_id == cid


@pytest.mark.anyio
async def test_fetch_client_id_mismatch():
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID,
            cache={},
            resolver=_resolver(PUBLIC),
            transport_factory=_transport(
                _json_handler(_doc(client_id="https://other.example/oauth/meta.json"))
            ),
        )
    assert e.value.code == "client_id_mismatch"


@pytest.mark.anyio
@pytest.mark.parametrize("status", [301, 302, 307, 308])
async def test_fetch_redirect_refused(status):
    seen: list[httpx.Request] = []
    handler = lambda req: httpx.Response(  # noqa: E731
        status, headers={"location": "http://169.254.169.254/latest"}
    )
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler, seen)
        )
    assert e.value.code == "invalid_document"
    assert len(seen) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(404, json=_doc()),
        httpx.Response(200, text="<html></html>", headers={"content-type": "text/html"}),
        httpx.Response(200, content=b"{not json", headers={"content-type": "application/json"}),
        httpx.Response(200, json=[1]),
        httpx.Response(200, json=_doc(redirect_uris="http://localhost/cb")),
        httpx.Response(200, json=_doc(redirect_uris=[])),
        httpx.Response(200, json=_doc(redirect_uris=["http://evil.example/cb"])),
        httpx.Response(200, json=_doc(token_endpoint_auth_method="client_secret_basic")),
    ],
)
async def test_fetch_invalid_documents(response):
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID,
            cache={},
            resolver=_resolver(PUBLIC),
            transport_factory=_transport(lambda req: response),
        )
    assert e.value.code == "invalid_document"


@pytest.mark.anyio
async def test_fetch_too_large_streamed():
    big = json.dumps(_doc(pad="x" * 70_000)).encode()

    async def chunks():
        for i in range(0, len(big), 4096):
            yield big[i : i + 4096]

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            async for c in chunks():
                yield c

    handler = lambda req: httpx.Response(  # noqa: E731
        200, headers={"content-type": "application/json"}, stream=Stream()
    )
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler)
        )
    assert e.value.code == "too_large"


@pytest.mark.anyio
async def test_fetch_too_large_by_content_length():
    big = json.dumps(_doc(pad="x" * 70_000)).encode()
    handler = lambda req: httpx.Response(  # noqa: E731
        200, content=big, headers={"content-type": "application/json"}
    )
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler)
        )
    assert e.value.code == "too_large"


@pytest.mark.anyio
async def test_fetch_timeout():
    def handler(req):
        raise httpx.ConnectTimeout("slow", request=req)

    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler)
        )
    assert e.value.code == "timeout"


@pytest.mark.anyio
async def test_fetch_cached_for_an_hour():
    cache: dict = {}
    calls: list = []
    seen: list = []
    t0 = utcnow()
    kw = dict(
        cache=cache,
        resolver=_resolver(PUBLIC, calls=calls),
        transport_factory=_transport(_json_handler(_doc()), seen),
    )
    a = await fetch_client_metadata(CID, now=t0, **kw)
    b = await fetch_client_metadata(CID, now=t0 + timedelta(minutes=59), **kw)
    assert a == b
    assert len(calls) == 1 and len(seen) == 1
    await fetch_client_metadata(CID, now=t0 + timedelta(seconds=3601), **kw)
    assert len(calls) == 2 and len(seen) == 2


# --------------------------------------------------------------------------- #
# Review fixes: raw-byte cap, validated fields only, DCR size caps
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("ip", ["fec0::1", "192.88.99.1"])
def test_check_address_refuses_non_global(ip):
    with pytest.raises(CimdError) as e:
        check_address(ip)
    assert e.value.code == "private_address"


@pytest.mark.anyio
async def test_fetch_sends_identity_and_refuses_compressed():
    import gzip

    seen: list[httpx.Request] = []
    body = gzip.compress(json.dumps(_doc()).encode())
    handler = lambda req: httpx.Response(  # noqa: E731
        200,
        content=body,
        headers={"content-type": "application/json", "content-encoding": "gzip"},
    )
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler, seen)
        )
    assert e.value.code == "invalid_document"
    assert seen[0].headers["accept-encoding"] == "identity"


@pytest.mark.anyio
async def test_fetch_identity_encoding_allowed():
    handler = lambda req: httpx.Response(  # noqa: E731
        200,
        content=json.dumps(_doc()).encode(),
        headers={"content-type": "application/json", "content-encoding": "identity"},
    )
    got = await fetch_client_metadata(
        CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler)
    )
    assert got.client_id == CID


@pytest.mark.anyio
async def test_fetch_raw_cap_stops_reading():
    chunk = b"x" * 4096
    pulled = []

    class Endless(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                pulled.append(len(chunk))
                yield chunk

    handler = lambda req: httpx.Response(  # noqa: E731
        200, headers={"content-type": "application/json"}, stream=Endless()
    )
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler)
        )
    assert e.value.code == "too_large"
    assert sum(pulled) <= 65_536 + len(chunk)


@pytest.mark.anyio
async def test_fetch_deeply_nested_body_is_invalid():
    # Stay under the 64 KB cap: depth matters, not size.
    nested = b"[" * 30_000 + b"]" * 30_000
    handler = lambda req: httpx.Response(  # noqa: E731
        200, content=nested, headers={"content-type": "application/json"}
    )
    with pytest.raises(CimdError) as e:
        await fetch_client_metadata(
            CID, cache={}, resolver=_resolver(PUBLIC), transport_factory=_transport(handler)
        )
    assert e.value.code == "invalid_document"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "uri",
    [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "http://client.example/logo.png",
        "https://user@client.example/logo.png",
        "https://client.example/" + "p" * 2048,
        42,
    ],
    ids=["javascript", "data", "http", "userinfo", "too_long", "not_a_string"],
)
async def test_fetch_drops_unsafe_uris(uri):
    got = await fetch_client_metadata(
        CID,
        cache={},
        resolver=_resolver(PUBLIC),
        transport_factory=_transport(_json_handler(_doc(client_uri=uri, logo_uri=uri))),
    )
    assert got.client_uri is None
    assert got.logo_uri is None


@pytest.mark.anyio
async def test_fetch_keeps_https_logo():
    got = await fetch_client_metadata(
        CID,
        cache={},
        resolver=_resolver(PUBLIC),
        transport_factory=_transport(
            _json_handler(_doc(logo_uri="https://client.example/logo.png"))
        ),
    )
    assert got.logo_uri == "https://client.example/logo.png"


@pytest.mark.anyio
async def test_fetch_metadata_is_allow_listed():
    t0 = utcnow()
    got = await fetch_client_metadata(
        CID,
        now=t0,
        cache={},
        resolver=_resolver(PUBLIC),
        transport_factory=_transport(
            _json_handler(
                _doc(
                    application_type="native",
                    grant_types=["authorization_code"],
                    response_types=["code"],
                    scope="mcp " + "x" * 2000,
                    evil={"nested": "x" * 1000},
                    jwks={"keys": []},
                )
            )
        ),
    )
    assert set(got.metadata) <= {
        "application_type",
        "grant_types",
        "response_types",
        "scope",
        "fetched_at",
    }
    assert got.metadata["fetched_at"] == t0.isoformat()
    assert got.metadata["application_type"] == "native"
    assert got.metadata["grant_types"] == ["authorization_code"]
    assert len(got.metadata["scope"]) <= 1000
    assert "client_id" not in got.metadata


def test_dcr_refuses_oversized_body(client):
    body = {"redirect_uris": ["https://a.example/cb"], "client_name": "x", "pad": "y" * 17_000}
    r = client.post("/oauth/register", json=body)
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_client_metadata"


@pytest.mark.parametrize(
    ("patch", "error"),
    [
        ({"scope": "s" * 1001}, "invalid_client_metadata"),
        ({"client_uri": "https://a.example/" + "p" * 2040}, "invalid_client_metadata"),
        ({"logo_uri": "https://a.example/" + "p" * 2040}, "invalid_client_metadata"),
        ({"redirect_uris": ["https://a.example/" + "p" * 2040]}, "invalid_redirect_uri"),
    ],
)
def test_dcr_length_caps(client, patch, error):
    body = {"redirect_uris": ["https://a.example/cb"], **patch}
    r = client.post("/oauth/register", json=body)
    assert r.status_code == 400, r.text
    assert r.json()["error"] == error


def test_dcr_accepts_at_caps(client):
    body = {
        "redirect_uris": ["https://a.example/" + "p" * (2048 - len("https://a.example/"))],
        "scope": "s" * 1000,
    }
    r = client.post("/oauth/register", json=body)
    assert r.status_code == 201, r.text
