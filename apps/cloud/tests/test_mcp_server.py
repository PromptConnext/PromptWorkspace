"""Hosted MCP endpoint at /mcp: bearer verification, transport security and
the three task tools (design 2026-10-24, "Cloud: the MCP endpoint").

Driven end to end through the SDK's own streamable-HTTP client over an
in-process ASGI transport, so the auth middleware, the session manager and
the tool layer all run exactly as they do behind uvicorn, with no network."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx2
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.config import get_settings
from app.db.merge import PLANNER_SEED_FIELDS
from app.main import create_app
from app.models.schemas import (
    GraphUpsertRequest,
    OAuthFamily,
    Role,
    SpecDocument,
    Task,
    TaskStatus,
)
from app.oauth.keys import load_signing_keys
from app.oauth.tokens import issue_access_token

BASE = "https://api.test"
PRM = f'resource_metadata="{BASE}/.well-known/oauth-protected-resource/mcp"'


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
def mcp_app(monkeypatch):
    monkeypatch.setenv("MCP_ENABLED", "1")
    monkeypatch.setenv("MCP_OAUTH_SIGNING_KEY", _pem())
    monkeypatch.setenv("PUBLIC_API_URL", f"{BASE}/")
    monkeypatch.setenv("CORS_ORIGINS", "https://web.test")
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "false")
    get_settings.cache_clear()
    app = create_app()
    yield app
    get_settings.cache_clear()


@asynccontextmanager
async def _running(app):
    async with app.router.lifespan_context(app):
        yield app.state.repository


def _http(app, token: str | None = None, **headers) -> httpx2.AsyncClient:
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url=BASE, headers=headers
    )


@asynccontextmanager
async def _session(app, token: str):
    async with _http(app, token) as http:
        async with streamable_http_client(f"{BASE}/mcp", http_client=http) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session


def _token(user="bob", family_id=None, repo=None) -> tuple[str, str]:
    settings = get_settings()
    key, _ = load_signing_keys(settings)
    fid = family_id or str(uuid.uuid4())
    if repo is not None:
        repo.put_oauth_family(OAuthFamily(family_id=fid, client_id="c1", user_id=user))
    token, _ = issue_access_token(
        settings, key, sub=user, email=f"{user}@x.com", client_id="c1", family_id=fid
    )
    return token, fid


def _seed(repo, *, spec_content: str | None = None):
    """alice admins a workspace; bob is a member with one assigned task."""
    ws = repo.create_workspace("Acme", "alice", "alice@x.com")
    repo.add_member(ws.id, "bob", Role.member, email="bob@x.com")
    project = repo.create_project(ws.id, "alice", "Alpha", repo_url="https://github.com/a/b")
    spec_id = None
    payload = GraphUpsertRequest()
    if spec_content is not None:
        spec_id = "spec-1"
        payload.spec_documents.append(
            SpecDocument(id=spec_id, project_id=project.id, requirement_id="r1",
                         content=spec_content)
        )  # fmt: skip
    payload.tasks.append(
        Task(id="t-1", project_id=project.id, title="Build login form", feature_tag="T012",
             spec_id=spec_id, assigned_user_id="bob")
    )  # fmt: skip
    repo.upsert_graph(project.id, payload, source="pz", seed_fields=PLANNER_SEED_FIELDS)
    return ws, project


def _text(result) -> str:
    return "".join(getattr(c, "text", "") for c in result.content)


# --------------------------------------------------------------------------- #
# Authentication
# --------------------------------------------------------------------------- #


@pytest.mark.anyio
async def test_unauthenticated_post_is_401_with_resource_metadata(mcp_app):
    async with _running(mcp_app), _http(mcp_app) as http:
        r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401
    assert PRM in r.headers["www-authenticate"]


@pytest.mark.anyio
async def test_supabase_shaped_hs256_token_is_401(mcp_app):
    forged = jwt.encode(
        {"sub": "bob", "aud": "authenticated", "role": "authenticated",
         "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())},
        "super-secret-jwt-token-with-at-least-32-characters", algorithm="HS256",
    )  # fmt: skip
    async with _running(mcp_app), _http(mcp_app, forged) as http:
        r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401
    assert PRM in r.headers["www-authenticate"]


@pytest.mark.anyio
async def test_token_for_another_audience_is_401(mcp_app):
    async with _running(mcp_app) as repo, _http(mcp_app) as http:
        settings = get_settings()
        key, _ = load_signing_keys(settings)
        fid = str(uuid.uuid4())
        repo.put_oauth_family(OAuthFamily(family_id=fid, client_id="c1", user_id="bob"))
        now = datetime.now(timezone.utc)
        other = jwt.encode(
            {"iss": settings.public_api_url, "sub": "bob", "aud": "https://other.test/mcp",
             "client_id": "c1", "fid": fid, "scope": "mcp", "email": "bob@x.com",
             "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=5)).timestamp()),
             "jti": "j1"},
            key.private_pem, algorithm="ES256", headers={"kid": key.kid},
        )  # fmt: skip
        r = await http.post(
            "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            headers={"Authorization": f"Bearer {other}"},
        )  # fmt: skip
    assert r.status_code == 401


@pytest.mark.anyio
async def test_unknown_family_is_401(mcp_app):
    async with _running(mcp_app), _http(mcp_app, _token()[0]) as http:
        r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401


@pytest.mark.anyio
async def test_revoked_family_is_401_after_cache_expiry(mcp_app):
    mcp_app.state.mcp_token_verifier.family_cache_ttl = 0
    async with _running(mcp_app) as repo:
        token, fid = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            await session.list_tools()
        repo.revoke_oauth_family(fid, "user_revoke", datetime.now(timezone.utc))
        async with _http(mcp_app, token) as http:
            r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401


@pytest.mark.anyio
async def test_valid_token_lists_the_task_tools_and_touches_the_family(mcp_app):
    async with _running(mcp_app) as repo:
        token, fid = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            names = {t.name for t in (await session.list_tools()).tools}
        assert repo.get_oauth_family(fid).last_used_at is not None
    assert names == {
        "list_my_tasks", "get_task", "close_task",
        "start_planning", "submit_repo_analysis", "submit_stage_draft",
    }  # fmt: skip


# --------------------------------------------------------------------------- #
# Mount and transport security
# --------------------------------------------------------------------------- #


@pytest.mark.anyio
async def test_mcp_with_and_without_slash_never_redirect(mcp_app):
    async with _running(mcp_app), _http(mcp_app) as http:
        a = await http.get("/mcp")
        b = await http.get("/mcp/")
    assert a.status_code == b.status_code == 401
    assert PRM in a.headers["www-authenticate"]


@pytest.mark.anyio
async def test_foreign_origin_is_403(mcp_app):
    async with _running(mcp_app) as repo:
        token, _ = _token(repo=repo)
        async with _http(mcp_app, token, Origin="https://evil.example") as http:
            r = await http.post(
                "/mcp",
                json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                headers={"Accept": "application/json, text/event-stream"},
            )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Tools
# --------------------------------------------------------------------------- #


@pytest.mark.anyio
async def test_list_my_tasks_drops_workspaces_the_user_left(mcp_app):
    async with _running(mcp_app) as repo:
        ws, project = _seed(repo)
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            before = await session.call_tool("list_my_tasks", {})
            assert not before.is_error, _text(before)
            assert "t-1" in _text(before)
            repo.remove_member(ws.id, "bob")
            after = await session.call_tool("list_my_tasks", {})
        assert not after.is_error, _text(after)
        assert "t-1" not in _text(after)
        # Still assigned: only the membership filter hides it.
        assert repo.get_task(project.id, "t-1").assigned_user_id == "bob"


@pytest.mark.anyio
async def test_close_task_implemented_requires_a_commit_sha(mcp_app):
    async with _running(mcp_app) as repo:
        _, project = _seed(repo)
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            missing = await session.call_tool(
                "close_task", {"task_id": "t-1", "status": "implemented"})
            bad = await session.call_tool(
                "close_task", {"task_id": "t-1", "status": "implemented", "commit_sha": "abc"})
        assert missing.is_error and "commit_sha" in _text(missing)
        assert bad.is_error
        assert repo.get_task(project.id, "t-1").status == TaskStatus.todo


@pytest.mark.anyio
async def test_close_task_implemented_records_the_artifact(mcp_app):
    sha = "a" * 40
    async with _running(mcp_app) as repo:
        _, project = _seed(repo)
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            res = await session.call_tool(
                "close_task", {"task_id": "t-1", "status": "implemented", "commit_sha": sha})
        assert not res.is_error, _text(res)
        assert repo.get_task(project.id, "t-1").status == TaskStatus.implemented
        artifacts = [a for a in repo._graph[project.id]["artifacts"].values()
                     if a.task_id == "t-1"]
        assert [a.commit_sha for a in artifacts] == [sha]


@pytest.mark.anyio
async def test_close_task_verified_needs_admin(mcp_app):
    async with _running(mcp_app) as repo:
        _, project = _seed(repo)
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            res = await session.call_tool("close_task", {"task_id": "t-1", "status": "verified"})
        assert res.is_error
        assert "verified_requires_admin: " in _text(res)
        assert repo.get_task(project.id, "t-1").status == TaskStatus.todo


@pytest.mark.anyio
async def test_task_of_someone_else_is_not_found(mcp_app):
    async with _running(mcp_app) as repo:
        _seed(repo)
        repo_ws = repo.create_workspace("Other", "carol", "carol@x.com")
        assert repo_ws
        token, _ = _token(user="carol", repo=repo)
        async with _session(mcp_app, token) as session:
            got = await session.call_tool("get_task", {"task_id": "t-1"})
            closed = await session.call_tool(
                "close_task", {"task_id": "t-1", "status": "in_progress"})
        assert got.is_error and "task_not_found: " in _text(got)
        assert closed.is_error and "task_not_found: " in _text(closed)


@pytest.mark.anyio
async def test_get_task_finds_a_task_past_a_thousand_assigned(mcp_app, monkeypatch):
    async with _running(mcp_app) as repo:
        _ws, project = _seed(repo)
        payload = GraphUpsertRequest()
        payload.tasks.extend(
            Task(id=f"t-x{i:04d}", project_id=project.id, title=f"Bulk {i}",
                 assigned_user_id="bob")
            for i in range(1001)
        )  # fmt: skip
        repo.upsert_graph(project.id, payload, source="pz", seed_fields=PLANNER_SEED_FIELDS)
        # Sorted by (project, feature_tag, id), this one is past any 1000-row cut.
        last = "t-x1000"

        def no_scan(*a, **k):  # pragma: no cover - must not be called
            raise AssertionError("get_task/close_task must not scan assigned tasks")

        monkeypatch.setattr(repo, "list_assigned_tasks", no_scan)
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            got = await session.call_tool("get_task", {"task_id": last})
            closed = await session.call_tool(
                "close_task", {"task_id": last, "status": "in_progress"})
    assert not got.is_error, _text(got)
    data = got.structured_content
    assert data.get("result", data)["task_id"] == last
    assert data.get("result", data)["workspace"] == "Acme"
    assert not closed.is_error, _text(closed)


@pytest.mark.anyio
async def test_task_of_a_left_workspace_is_not_found(mcp_app):
    async with _running(mcp_app) as repo:
        ws, _project = _seed(repo)
        repo.remove_member(ws.id, "bob")
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            got = await session.call_tool("get_task", {"task_id": "t-1"})
    assert got.is_error and "task_not_found: " in _text(got)


@pytest.mark.anyio
@pytest.mark.parametrize("revoke_all", [False, True])
async def test_revoke_from_connected_agents_is_immediate(mcp_app, revoke_all):
    # Default family cache TTL: revocation through /me evicts the family.
    assert mcp_app.state.mcp_token_verifier.family_cache_ttl == 30.0
    async with _running(mcp_app) as repo:
        token, fid = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            await session.list_tools()
        path = "/me/oauth-grants" if revoke_all else f"/me/oauth-grants/{fid}"
        async with _http(mcp_app, **{"X-User-Id": "bob"}) as http:
            assert (await http.delete(path)).status_code == 204
        async with _http(mcp_app, token) as http:
            r = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401


@pytest.mark.anyio
async def test_get_task_truncates_the_spec_excerpt(mcp_app):
    async with _running(mcp_app) as repo:
        _seed(repo, spec_content="x" * 5000)
        token, _ = _token(repo=repo)
        async with _session(mcp_app, token) as session:
            res = await session.call_tool("get_task", {"task_id": "t-1"})
    assert not res.is_error, _text(res)
    data = res.structured_content
    data = data.get("result", data)
    excerpt = data["spec_excerpt"]
    assert excerpt.startswith("x" * 4000)
    assert excerpt.endswith("…(truncated)")
    assert len(excerpt.replace("…(truncated)", "").strip()) == 4000
    assert data["ref"] == "T12"
    assert data["commit_prefix"] == "T12:"
    assert data["branch_name"] == "T12-build-login-form"
    assert data["repo_url"] == "https://github.com/a/b"
    assert data["constitution_present"] is False
    assert data["status"] == "todo"
