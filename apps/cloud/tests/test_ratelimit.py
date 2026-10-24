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


def test_register_per_ip_hourly_limit():
    c1, c2 = _client(_build(), "1.1.1.1"), None
    codes = [c1.post("/oauth/register").status_code for _ in range(6)]
    assert codes == [200] * 5 + [429]
    assert "Retry-After" in c1.post("/oauth/register").headers
    c2 = TestClient(c1.app, client=("2.2.2.2", 1))
    assert c2.post("/oauth/register").status_code == 200


def test_register_31st_call_in_an_hour_is_429(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: now[0])
    c = _client(_build(), "1.1.1.1")
    codes = []
    for _ in range(35):
        codes.append(c.post("/oauth/register").status_code)
        now[0] += 60  # 30/hour sustained = one token per 120s, so we outrun refill
    # 5 burst + 1 refill per 2 calls: bucket drains and starts rejecting
    assert 429 in codes
    now[0] += 3600
    assert c.post("/oauth/register").status_code == 200


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
