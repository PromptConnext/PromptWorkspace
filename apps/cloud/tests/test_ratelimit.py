"""Named rate-limit rules (hosted MCP / OAuth) and identity hardening."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app import ratelimit
from app.ratelimit import RateLimitMiddleware, default_rules, identity


def _settings(stub_mode: bool, per_minute: int = 1000, burst: int = 1000):
    return SimpleNamespace(
        rate_limit_per_minute=per_minute,
        rate_limit_burst=burst,
        auth_mode="stub" if stub_mode else "supabase",
    )


def _build(stub_mode: bool = True, **kw) -> FastAPI:
    app = FastAPI()

    @app.post("/oauth/register")
    async def register():
        return {"ok": 1}

    @app.get("/oauth/authorize")
    async def authorize():
        return {"ok": 1}

    @app.post("/oauth/token")
    async def token(request: Request):
        return {"body": (await request.body()).decode()}

    @app.get("/mcp")
    async def mcp():
        return {"ok": 1}

    @app.get("/sync/x")
    async def sync():
        return {"ok": 1}

    @app.get("/other")
    async def other():
        return {"ok": 1}

    app.add_middleware(
        RateLimitMiddleware, rules=default_rules(_settings(stub_mode, **kw))
    )
    return app


def _client(app: FastAPI, ip: str = "1.2.3.4") -> TestClient:
    return TestClient(app, client=(ip, 1234))


def _req(headers: dict[str, str], host: str | None = "9.9.9.9") -> Request:
    return Request(
        {
            "type": "http",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": (host, 1) if host else None,
        }
    )


def test_identity_ignores_x_user_id_outside_stub_mode():
    r = _req({"x-user-id": "alice"})
    assert identity(r, stub_mode=False) == "ip:9.9.9.9"
    assert identity(r, stub_mode=True) == "user:alice"


def test_identity_token_suffix_then_ip():
    tok = "Bearer " + "x" * 40 + "ABCDEFGHIJKLMNOPQRSTUVWX"
    assert identity(_req({"authorization": tok, "x-user-id": "a"}), stub_mode=False) == (
        "tok:ABCDEFGHIJKLMNOPQRSTUVWX"
    )
    assert identity(_req({}, host=None), stub_mode=False) == "ip:unknown"


def test_register_6th_rapid_call_from_one_ip_is_429_other_ip_passes():
    c1, c2 = _client(_build(), "1.1.1.1"), None
    codes = [c1.post("/oauth/register").status_code for _ in range(6)]
    assert codes == [200] * 5 + [429]
    assert "Retry-After" in c1.post("/oauth/register").headers
    c2 = TestClient(c1.app, client=("2.2.2.2", 1))
    assert c2.post("/oauth/register").status_code == 200


def test_register_bucket_refills_at_30_per_hour(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: now[0])
    c = _client(_build(), "1.1.1.1")
    assert [c.post("/oauth/register").status_code for _ in range(6)] == [200] * 5 + [429]
    now[0] += 120  # one token per 120s at 30/hour
    assert c.post("/oauth/register").status_code == 200
    assert c.post("/oauth/register").status_code == 429


def test_register_global_bucket_caps_across_ips():
    app = _build()
    codes = []
    for i in range(40):
        codes.append(_client(app, f"10.0.0.{i}").post("/oauth/register").status_code)
    assert codes[:30] == [200] * 30
    assert codes[30:] == [429] * 10


def test_authorize_limits_only_cimd_https_client_id():
    c = _client(_build())
    plain = [c.get("/oauth/authorize?client_id=abc").status_code for _ in range(10)]
    assert set(plain) == {200}
    cimd = [
        c.get("/oauth/authorize?client_id=https://app.example/c.json").status_code
        for _ in range(6)
    ]
    assert cimd == [200] * 5 + [429]


def test_mcp_does_not_consume_token_bucket():
    c = _client(_build(), "3.3.3.3")
    for _ in range(30):
        assert c.get("/mcp").status_code == 200
    assert c.post("/oauth/token", data={"client_id": "z"}).status_code == 200


def test_token_keyed_by_client_id_and_body_reinjected():
    app = _build()
    c = _client(app)
    for _ in range(20):
        r = c.post("/oauth/token", data={"client_id": "A", "code": "xyz"})
        assert r.status_code == 200
    assert "client_id=A" in r.json()["body"]  # route still sees the body
    assert c.post("/oauth/token", data={"client_id": "A"}).status_code == 429
    assert c.post("/oauth/token", data={"client_id": "B"}).status_code == 200


def test_token_same_client_id_from_two_ips_has_independent_buckets():
    # A CIMD client_id (Claude Code's) is shared by every user of that client:
    # one source draining it must not lock everyone else out.
    app = _build()
    attacker, victim = _client(app, "6.6.6.6"), _client(app, "5.5.5.5")
    cid = "https://claude.ai/oauth/claude-code-client-metadata"
    for _ in range(20):
        assert attacker.post("/oauth/token", data={"client_id": cid}).status_code == 200
    assert attacker.post("/oauth/token", data={"client_id": cid}).status_code == 429
    assert victim.post("/oauth/token", data={"client_id": cid}).status_code == 200


def test_token_key_combines_client_id_and_ip():
    import asyncio

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/oauth/token",
        "query_string": b"client_id=Q",
        "headers": [],
        "client": ("7.7.7.7", 1),
    }
    key = asyncio.run(ratelimit._token_client_key(Request(scope)))
    assert key == "client:Q|ip:7.7.7.7"


def test_token_client_id_from_query_and_non_form_falls_back_to_ip():
    c = _client(_build())
    for _ in range(20):
        c.post("/oauth/token?client_id=Q")
    assert c.post("/oauth/token?client_id=Q").status_code == 429
    for _ in range(20):
        c.post("/oauth/token", json={"client_id": "J"})
    assert c.post("/oauth/token", json={"client_id": "J"}).status_code == 429


def test_sync_uses_api_rule_and_unmatched_passes():
    c = _client(_build(per_minute=1, burst=2))
    codes = [c.get("/sync/x").status_code for _ in range(3)]
    assert codes == [200, 200, 429]
    assert all(c.get("/other").status_code == 200 for _ in range(10))


@pytest.mark.parametrize("stub", [True, False])
def test_sync_bucket_keyed_by_user_only_in_stub_mode(stub):
    c = _client(_build(stub_mode=stub, per_minute=1, burst=1))
    assert c.get("/sync/x", headers={"x-user-id": "a"}).status_code == 200
    second = c.get("/sync/x", headers={"x-user-id": "b"}).status_code
    assert second == (200 if stub else 429)


def test_chunked_token_body_is_not_buffered_and_keyed_by_ip():
    app = _build()
    def gen():
        yield b"client_id=A&code="
        yield b"x" * 100

    c = _client(app)
    hdr = {"content-type": "application/x-www-form-urlencoded"}
    # generator body -> Transfer-Encoding: chunked, no Content-Length
    r = c.post("/oauth/token", content=gen(), headers=hdr)
    assert r.status_code == 200
    assert r.json()["body"].startswith("client_id=A")  # route still gets it
    # Keyed by ip: the 20-token ip bucket drains, client:A's own bucket is untouched.
    for _ in range(19):
        c.post("/oauth/token", content=gen(), headers=hdr)
    assert c.post("/oauth/token", data={"client_id": "A"}).status_code == 200
    assert (
        c.post("/oauth/token", content=gen(), headers=hdr).status_code == 429
    )


def test_token_key_does_not_read_body_without_content_length(monkeypatch):
    called = []
    orig = Request.body

    async def spy(self):
        called.append(1)
        return await orig(self)

    monkeypatch.setattr(Request, "body", spy)
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/oauth/token",
        "query_string": b"",
        "headers": [(b"content-type", b"application/x-www-form-urlencoded")],
        "client": ("7.7.7.7", 1),
    }
    import asyncio

    key = asyncio.run(ratelimit._token_client_key(Request(scope)))
    assert key == "ip:7.7.7.7" and not called


def test_mcp_prefix_is_exact_and_cimd_scheme_case_insensitive():
    c = _client(_build())
    assert all(c.get("/mcpfoo").status_code == 404 for _ in range(70))  # never limited
    codes = [c.get("/oauth/authorize?client_id=HTTPS://a/b").status_code for _ in range(6)]
    assert codes[-1] == 429
