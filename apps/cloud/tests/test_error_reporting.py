"""What an error report is allowed to contain (plan 0021 M2).

These are the milestone's actual deliverable. Installing an SDK is an
afternoon; the week is proving that the SDK's *defaults* — stack-frame local
variables, request bodies, request headers — cannot carry a customer's source
file, a decrypted model key, a workspace GitHub PAT or a bearer token out of
this process.

Every assertion here runs against a real `sentry_sdk.init()` with a
substituted transport (`init_sentry(..., transport=...)`), so what is
inspected is the serialised event that would have been sent over the wire —
not a mock of the scrub function, which would pass happily if the SDK stopped
calling it.
"""

from __future__ import annotations

import asyncio
import json
import logging

import pytest
import sentry_sdk
from fastapi import Depends, Request
from fastapi.testclient import TestClient
from sentry_sdk.transport import Transport

from app.api._guards import require_workspace
from app.config import Settings
from app.dependencies import get_current_user
from app.main import create_app
from app.observability import _sanitize_url, before_send, init_sentry
from app.rag.queue import EmbedJob, _process_code_file_job
from app.ratelimit import _identity

ALICE = {"X-User-Id": "alice"}

# Syntactically valid so the SDK enables itself, pointed at a discard port,
# and never contacted regardless: the fixture below substitutes the transport,
# so no event ever reaches a socket. This is not a placeholder for a real
# project's DSN — nothing in app/ or .env.example carries one.
_TEST_DSN = "http://publickey@127.0.0.1:9/0"

# Stand-ins chosen to be unmistakable in a serialised event: if any of these
# strings survives into an event body, a real secret would have too.
CUSTOMER_SOURCE = "def transfer_funds():\n    return 'CUSTOMER-SOURCE-CANARY'\n"
MODEL_API_KEY = "sk-CANARY-model-key"
GITHUB_PAT = "github_pat_CANARY_workspace_token"
BEARER_TOKEN = "eyJCANARYbearer.tokenvalue.signature"
# A workspace invitation token. Not a "sort of" credential: presenting it is
# what grants membership, so it is bearer-equivalent.
INVITE_TOKEN = "CANARY-invitation-token-grants-membership"


class _CapturingTransport(Transport):
    """Stands in for the HTTP transport, so an "event" in these tests is the
    fully-built, scrubbed envelope payload that would have gone over the wire
    — not an intermediate the scrub hook might still be about to touch."""

    def __init__(self, sink: list[dict]) -> None:
        super().__init__()
        self._sink = sink

    def capture_envelope(self, envelope) -> None:
        for item in envelope.items:
            payload = item.payload.json
            if payload is not None and item.headers.get("type") in (None, "event"):
                self._sink.append(payload)


@pytest.fixture
def events() -> list[dict]:
    """Real SDK, real option set, captured transport."""
    captured: list[dict] = []
    settings = Settings(sentry_dsn=_TEST_DSN, app_env="test")
    assert (
        init_sentry(settings, release="test", transport=_CapturingTransport(captured)) is True
    )
    try:
        yield captured
    finally:
        # Leave the process with a disabled client so the other ~600 tests
        # capture nothing. The framework patches the SDK installed stay, but
        # they are no-ops without a client.
        sentry_sdk.init(dsn=None)


def _dump(event: dict) -> str:
    return json.dumps(event, default=str)


def _frames(event: dict) -> list[dict]:
    frames: list[dict] = []
    for value in (event.get("exception") or {}).get("values") or []:
        frames.extend((value.get("stacktrace") or {}).get("frames") or [])
    return frames


# --------------------------------------------------------------------------
# 1. Frame locals — the option the ADR 0011 guarantee rests on.
# --------------------------------------------------------------------------


def test_stack_frame_locals_are_never_captured(events: list[dict]):
    def chunk_and_embed() -> None:
        # The shape of app/rag/queue.py::_process_code_file_job: a customer's
        # file, transiently, in a local.
        content = CUSTOMER_SOURCE
        api_key = MODEL_API_KEY
        assert content and api_key
        raise RuntimeError("embedding provider unavailable")

    try:
        chunk_and_embed()
    except RuntimeError:
        sentry_sdk.capture_exception()

    assert len(events) == 1
    body = _dump(events[0])
    assert "CUSTOMER-SOURCE-CANARY" not in body
    assert MODEL_API_KEY not in body
    # Not merely absent by luck: no frame carries a `vars` block at all.
    assert _frames(events[0])
    assert all("vars" not in frame for frame in _frames(events[0]))


def test_before_send_strips_frame_vars_the_sdk_might_still_attach():
    """Defence in depth behind `include_local_variables=False`: if a future
    SDK default, a hand-built event or an integration reintroduces frame
    locals, the hook itself still drops them."""
    event = {
        "exception": {
            "values": [
                {
                    "stacktrace": {
                        "frames": [
                            {"function": "_process_code_file_job", "vars": {"content": "x"}}
                        ]
                    }
                }
            ]
        },
        "threads": {
            "values": [{"stacktrace": {"frames": [{"vars": {"api_key": MODEL_API_KEY}}]}}]
        },
        "stacktrace": {"frames": [{"vars": {"token": GITHUB_PAT}}]},
    }
    scrubbed = before_send(event, None)
    assert MODEL_API_KEY not in _dump(scrubbed)
    assert GITHUB_PAT not in _dump(scrubbed)
    assert "vars" not in _dump(scrubbed)


def test_code_indexing_failure_reports_no_source_key_or_pat(events: list[dict]):
    """The real call chain, not a look-alike.

    `_process_code_file_job` is the one frame in this service holding a
    customer's source file (`content`/`texts`), their decrypted model key
    (`api_key`) and their workspace GitHub PAT (`token`) simultaneously. This
    drives it to the point where the embedder raises — exactly the failure
    `embed_worker_loop` would report — and asserts none of the three reaches
    the event.
    """

    class _SourceReturningGithub:
        async def fetch_file_content(self, token, repo, path, sha):
            assert token == GITHUB_PAT
            return CUSTOMER_SOURCE

    class _ExplodingEmbedder:
        async def embed(self, texts, model, api_key, base_url, dim=None):
            assert api_key == MODEL_API_KEY
            raise RuntimeError("embeddings endpoint returned 503")

    app = create_app()
    with TestClient(app) as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        # Seeded through the repository rather than POST /model-connection:
        # that endpoint health-checks the base_url against the live network,
        # and this test is about what a failure reports, not about connecting.
        repo = client.app.state.repository
        secret_store = client.app.state.secret_store
        repo.upsert_model_connection(
            workspace_id=ws["id"],
            provider="openai",
            base_url="https://api.example.com/v1",
            model="gpt-x",
            embed_model="embed-x",
            embed_dim=32,
            secret_ref=secret_store.encrypt(MODEL_API_KEY),
            daily_token_budget=200_000,
            created_by="alice",
        )
        # Same reasoning for the PAT: PUT /integrations/github verifies the
        # token against GitHub before storing it.
        repo.update_workspace(
            ws["id"],
            integration_config={
                "github": {"owner": "acme", "secret_ref": secret_store.encrypt(GITHUB_PAT)}
            },
        )

        client.app.state.github_client = _SourceReturningGithub()
        client.app.state.embedding_provider = _ExplodingEmbedder()

        job = EmbedJob(
            workspace_id=ws["id"],
            project_id=project["id"],
            node_type="code_file",
            node_id="acme/rocket:src/pay.py",
            repo="acme/rocket",
            path="src/pay.py",
            sha="deadbeef",
        )
        try:
            asyncio.run(_process_code_file_job(client.app, job))
        except RuntimeError:
            sentry_sdk.capture_exception()

    assert len(events) == 1, "the embedder failure should have produced exactly one event"
    body = _dump(events[0])
    assert "CUSTOMER-SOURCE-CANARY" not in body, "ADR 0011: source code must never be reported"
    assert MODEL_API_KEY not in body
    assert GITHUB_PAT not in body


def test_rate_limit_bearer_suffix_key_is_not_captured(events: list[dict]):
    """app/ratelimit.py::_identity keys a bucket on the last 24 characters of
    the bearer token — enough of a real credential to matter."""

    class _Req:
        headers = {"authorization": f"Bearer {BEARER_TOKEN}"}
        client = None

    def limit_and_fail() -> None:
        key = _identity(_Req())
        assert key.startswith("tok:")
        raise RuntimeError("bucket lookup failed")

    try:
        limit_and_fail()
    except RuntimeError:
        sentry_sdk.capture_exception()

    body = _dump(events[0])
    assert BEARER_TOKEN[-24:] not in body


# --------------------------------------------------------------------------
# 2. Request context — headers, body, cookies.
# --------------------------------------------------------------------------


def _client_with_exploding_route() -> TestClient:
    """An app identical to production plus one route that raises after the
    real auth dependency and the real membership guard have run — so the event
    carries the request context and tags a genuine 500 would."""
    app = create_app()

    @app.post("/__test__/boom/{workspace_id}")
    def boom(workspace_id: str, request: Request, user=Depends(get_current_user)):
        require_workspace(request.app.state.repository, workspace_id, user)
        raise RuntimeError("unhandled failure in a request handler")

    return TestClient(app, raise_server_exceptions=False)


def _trigger(client: TestClient, **kwargs):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    res = client.post(f"/__test__/boom/{ws['id']}", **kwargs)
    assert res.status_code == 500
    return ws["id"]


def test_authorization_header_is_scrubbed_from_the_request_context(events: list[dict]):
    with _client_with_exploding_route() as client:
        _trigger(
            client,
            headers={**ALICE, "Authorization": f"Bearer {BEARER_TOKEN}"},
            json={},
        )

    assert events, "the Starlette/FastAPI integration should have captured the 500"
    event = events[-1]
    # Sentry normalises header names to lower case in the request context.
    headers = event["request"]["headers"]
    assert BEARER_TOKEN not in _dump(event)
    assert headers["authorization"] == "[redacted]"
    # The benign ones are untouched, or the report loses its diagnostic value.
    assert headers["content-type"] == "application/json"


def test_x_user_id_header_is_scrubbed_from_the_request_context(events: list[dict]):
    """`X-User-Id` is the whole credential under AUTH_MODE=stub, and Sentry's
    own default header denylist does not include it — this one is ours."""
    with _client_with_exploding_route() as client:
        _trigger(client, headers={"X-User-Id": "alice"}, json={})

    headers = events[-1]["request"]["headers"]
    # Present-but-redacted, not silently dropped — a report should still show
    # that the header was sent.
    assert headers["x-user-id"] == "[redacted]"


def test_uploaded_document_bodies_are_never_captured(events: list[dict]):
    """Defence in depth: `max_request_body_size="never"` should already mean
    no body is collected, and `before_send` pops `request["data"]` regardless.
    A PRD posted to this service is customer content."""
    with _client_with_exploding_route() as client:
        _trigger(
            client,
            headers=ALICE,
            json={"content": "CONFIDENTIAL-PRD-CANARY the acquisition closes in Q3"},
        )

    event = events[-1]
    assert "CONFIDENTIAL-PRD-CANARY" not in _dump(event)
    assert "data" not in event["request"]


def test_before_send_scrubs_headers_and_bodies_from_a_hand_built_event():
    """Unit-level counterpart to the two tests above, covering the shapes the
    live SDK happens not to produce today: header pair-lists, cookies, the
    WSGI environ, and credential-shaped keys nested in breadcrumbs or extra."""
    event = {
        "request": {
            "headers": [["Authorization", "Bearer x"], ["X-Hub-Signature-256", "sha256=y"]],
            "cookies": {"session": "abc"},
            "env": {"SUPABASE_KEY": "service-role"},
            "data": {"content": "CONFIDENTIAL-PRD-CANARY"},
            "url": "https://api.example.com/projects/1/documents",
        },
        "breadcrumbs": {
            "values": [
                {
                    "category": "httpx",
                    "data": {"url": "https://api.github.com", "api_key": MODEL_API_KEY},
                }
            ]
        },
        "extra": {"connection": {"secret_ref": "enc:abc", "base_url": "https://x"}},
    }
    scrubbed = before_send(event, None)
    body = _dump(scrubbed)

    assert "CONFIDENTIAL-PRD-CANARY" not in body
    assert MODEL_API_KEY not in body
    assert "service-role" not in body
    assert "abc" not in body  # cookie value and secret_ref both gone
    assert "sha256=y" not in body
    # The non-sensitive neighbours survive, or the report would be useless.
    # This URL carries no credential, so it comes through intact — the
    # project id is ours, the same class of value as the tags below.
    assert scrubbed["request"]["url"] == "https://api.example.com/projects/1/documents"
    assert scrubbed["extra"]["connection"]["base_url"] == "https://x"


# --------------------------------------------------------------------------
# 2b. Secrets with no key name: the URL path and the query string.
#
# A key-name denylist is blind to these by construction — the key is "url" or
# "query_string" and the credential is part of the value. Both of the routes
# below are real, and both were leaking before the security review caught it.
# --------------------------------------------------------------------------


def test_the_invitation_token_in_the_url_path_is_redacted(events: list[dict]):
    """`POST /invitations/{token}/accept` (app/api/workspaces.py:261) carries a
    bearer-equivalent in its *path*: that token grants workspace membership to
    whoever presents it. The handler only catches KeyError, so any other
    repository failure is an uncaught 500 — and the URL rides along with it.

    Driven through the real route, with the real repository made to fail.
    """
    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as client:
        repo = client.app.state.repository

        def _explode(token: str, user_id: str):
            raise RuntimeError("invitation lookup failed")

        repo.accept_invitation = _explode  # type: ignore[method-assign]
        res = client.post(f"/invitations/{INVITE_TOKEN}/accept", headers=ALICE)
        assert res.status_code == 500

    assert events, "an uncaught 500 in the accept route should have been captured"
    event = events[-1]
    body = _dump(event)
    assert INVITE_TOKEN not in body, "the invitation token must not leave this process"
    # The route shape survives — that is what makes the report readable.
    assert event["request"]["url"].endswith("/invitations/[redacted]/accept")


def test_a_token_in_the_query_string_never_reaches_an_event(events: list[dict]):
    """The presence WebSocket (app/api/presence.py:34) takes the caller's
    Supabase JWT as `?token=`. `query_string` is dropped wholesale rather than
    filtered, so this holds for any future query parameter too."""
    with _client_with_exploding_route() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        res = client.post(
            f"/__test__/boom/{ws['id']}?token={BEARER_TOKEN}&user_id=alice",
            headers=ALICE,
            json={},
        )
        assert res.status_code == 500

    event = events[-1]
    assert BEARER_TOKEN not in _dump(event)
    assert "query_string" not in event["request"]
    assert "?" not in event["request"]["url"]


def test_a_query_string_token_does_not_survive_in_the_breadcrumb_trail(events: list[dict]):
    """Popping `request["query_string"]` is not the whole fix.

    `StdlibIntegration` records an `httplib` breadcrumb for every **outgoing**
    HTTP call, and it splits the URL into `url` + `http.query` + `http.fragment`
    — so sanitising URL-shaped values alone leaves the query behind under a key
    that a credential-name denylist does not match either (`http.query` has no
    "token"/"secret" in it). Those breadcrumbs sit in the trail and ride out on
    the next event captured in the enclosing scope, so a call that never itself
    failed can leak through an unrelated later error.

    This was found by the test suite, not by reading the SDK, and it is why
    `_QUERY_KEY_PARTS` matches on the key *shape* rather than on a
    credential-sounding name.
    """
    with _client_with_exploding_route() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        client.get(f"/workspaces/{ws['id']}?token={BEARER_TOKEN}", headers=ALICE)

    # Captured outside any request scope, which is where the accumulated
    # outbound-call trail is visible.
    sentry_sdk.capture_message("something unrelated went wrong later")

    event = events[-1]
    crumbs = [
        c
        for c in (event.get("breadcrumbs") or {}).get("values") or []
        if isinstance(c.get("data"), dict) and "http.query" in c["data"]
    ]
    assert crumbs, "expected an httplib breadcrumb carrying http.query"
    assert all(c["data"]["http.query"] == "[redacted]" for c in crumbs)
    # The URL half survives so the breadcrumb still says which call it was.
    assert any(c["data"].get("url", "").startswith("http://testserver/") for c in crumbs)
    assert BEARER_TOKEN not in _dump(event)


def test_sanitize_url_drops_query_and_fragment_but_keeps_our_own_ids():
    # The web app's recovery link shape: the Supabase tokens are in the
    # fragment, which never survives.
    assert (
        _sanitize_url(
            "https://app.example.com/reset-password"
            "#access_token=CANARY-JWT&refresh_token=CANARY-REFRESH&type=recovery"
        )
        == "https://app.example.com/reset-password"
    )
    # The presence WebSocket shape.
    assert (
        _sanitize_url("wss://api.example.com/ws/projects/p1/presence?token=CANARY-JWT")
        == "wss://api.example.com/ws/projects/p1/presence"
    )
    # Our own identifiers are left alone on purpose: redacting them would
    # leave a report that cannot be tied to a project or a task.
    assert (
        _sanitize_url("https://api.example.com/projects/p1/tasks/t2/status")
        == "https://api.example.com/projects/p1/tasks/t2/status"
    )
    # A relative URL (what some integrations record) is handled too.
    assert _sanitize_url("/invite/CANARY-INVITE") == "/invite/[redacted]"


def test_urls_nested_in_breadcrumbs_and_contexts_are_sanitised_too():
    scrubbed = before_send(
        {
            "breadcrumbs": {
                "values": [
                    {
                        "category": "httplib",
                        "data": {
                            "url": f"https://api.example.com/invitations/{INVITE_TOKEN}/accept",
                            "method": "POST",
                        },
                    }
                ]
            },
            "contexts": {"response": {"location": f"/reset-password#access_token={BEARER_TOKEN}"}},
        },
        None,
    )
    body = _dump(scrubbed)
    assert INVITE_TOKEN not in body
    assert BEARER_TOKEN not in body
    # The method survives, so the breadcrumb still says what happened.
    assert scrubbed["breadcrumbs"]["values"][0]["data"]["method"] == "POST"


def test_log_record_arguments_never_reach_an_event(events: list[dict]):
    """`logger.error("tok=%s", tok)` reaches Sentry as three fields, and TWO of
    them carry the argument: `params` (the positional list) and `formatted`
    (the rendered string). Dropping only `params` — the obvious fix — still
    leaks via `formatted`, which is how this was caught. No call site
    interpolates a secret today; nothing prevents one."""
    logging.getLogger("promptconnext.test").error("credential was %s", BEARER_TOKEN)

    assert events, "an ERROR log record should have produced an event"
    event = events[-1]
    assert BEARER_TOKEN not in _dump(event)
    logentry = event.get("logentry") or {}
    assert "params" not in logentry
    assert "formatted" not in logentry
    # The format string survives, so the report still names what failed.
    assert logentry["message"] == "credential was %s"


def test_argv_is_not_attached_to_events(events: list[dict]):
    """ArgvIntegration's `extra["sys.argv"]` is a positional list the key-name
    scrub cannot see into, so the integration is disabled outright."""
    sentry_sdk.capture_message("something happened")
    assert "sys.argv" not in (events[-1].get("extra") or {})


# --------------------------------------------------------------------------
# 3. What a report IS allowed to carry.
# --------------------------------------------------------------------------


def test_user_and_workspace_ids_land_as_tags(events: list[dict]):
    with _client_with_exploding_route() as client:
        ws_id = _trigger(client, headers=ALICE, json={})

    tags = events[-1]["tags"]
    assert tags["user_id"] == "alice"
    assert tags["workspace_id"] == ws_id


def test_the_request_id_lands_as_a_tag(events: list[dict]):
    """Plan 0021 M3. Not asked for by the plan, which predates M2 in its own
    numbering, and the cheapest possible completion of it: the id is already
    bound per request by app/requestlog.py, and as a tag it is the join between
    an error report and the JSON log lines of the same request — otherwise the
    two halves of the milestone answer "which request?" separately and neither
    can reach the other.
    """
    with _client_with_exploding_route() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        res = client.post(
            f"/__test__/boom/{ws['id']}",
            headers={**ALICE, "X-Request-Id": "req-from-the-browser"},
            json={},
        )
        assert res.status_code == 500

    # This is the correlation path for an *unhandled* 500 specifically:
    # Starlette builds that response in `ServerErrorMiddleware`, which sits
    # above every user middleware, so it is the one response shape the echo
    # header does not reach (see app/requestlog.py::RequestIdMiddleware). The
    # tag is what ties the report to the log lines the handler emitted before
    # it raised.
    assert events[-1]["tags"]["request_id"] == "req-from-the-browser"


def test_tags_do_not_leak_between_requests(events: list[dict]):
    """The tags are set on the per-request isolation scope the SDK's ASGI
    integration forks, not on module-level state — so a second request as a
    different user must not inherit the first one's identity."""
    bob = {"X-User-Id": "bob"}
    with _client_with_exploding_route() as client:
        alice_ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        bob_ws = client.post("/workspaces", json={"name": "W2"}, headers=bob).json()
        assert client.post(
            f"/__test__/boom/{alice_ws['id']}", headers=ALICE, json={}
        ).status_code == 500
        assert client.post(
            f"/__test__/boom/{bob_ws['id']}", headers=bob, json={}
        ).status_code == 500

    assert len(events) == 2
    assert events[0]["tags"]["user_id"] == "alice"
    assert events[0]["tags"]["workspace_id"] == alice_ws["id"]
    assert events[1]["tags"]["user_id"] == "bob"
    assert events[1]["tags"]["workspace_id"] == bob_ws["id"]
    # Same reasoning one level down for the request id (plan 0021 M3): it is
    # minted per request, so two reports sharing one would mean the scope was
    # not forked. Asserted by inequality rather than by value because the
    # middleware minted both.
    assert events[0]["tags"]["request_id"] != events[1]["tags"]["request_id"]
    # And the tag set as a whole stays closed: nothing else may accumulate
    # here, since every key in it is sent to a third party unscrubbed.
    assert set(events[0]["tags"]) == {"user_id", "workspace_id", "request_id"}


# --------------------------------------------------------------------------
# 4. Configuration.
# --------------------------------------------------------------------------


def test_init_sentry_is_a_noop_without_a_dsn(monkeypatch):
    """No DSN must mean no `sentry_sdk.init()` call at all — not an init with
    sending switched off. That is what keeps dev runs and this suite free of
    patched frameworks and a live client."""
    calls: list[dict] = []
    monkeypatch.setattr(
        "app.observability.sentry_sdk.init", lambda **kwargs: calls.append(kwargs)
    )
    assert init_sentry(Settings(app_env="development"), release="test") is False
    assert init_sentry(Settings(app_env="production", sentry_dsn=""), release="t") is False
    assert calls == []


def test_init_sentry_disables_the_dangerous_defaults():
    """The three SDK defaults that would ship customer data, asserted on the
    live client's resolved options rather than on the call site."""
    settings = Settings(sentry_dsn=_TEST_DSN, app_env="test")
    try:
        assert init_sentry(settings, release="test", transport=_CapturingTransport([])) is True
        options = sentry_sdk.get_client().options
        assert options["include_local_variables"] is False
        assert options["max_request_body_size"] == "never"
        assert options["send_default_pii"] is False
        assert options["before_send"] is before_send
        assert options["before_send_transaction"] is before_send
        # Errors only this milestone — tracing stays off (plan 0021 M3).
        assert options["traces_sample_rate"] is None
        assert options["environment"] == "test"
    finally:
        sentry_sdk.init(dsn=None)


def test_production_without_a_dsn_warns_but_does_not_raise():
    settings = Settings(
        app_env="production",
        auth_mode="supabase",
        cors_origins="https://app.promptconnext.com",
        sentry_dsn=None,
    )
    warnings = settings.require_production_safety()
    assert len(warnings) == 1
    assert "Sentry DSN" in warnings[0]


def test_production_with_a_dsn_does_not_warn():
    settings = Settings(
        app_env="production",
        auth_mode="supabase",
        cors_origins="https://app.promptconnext.com",
        sentry_dsn=_TEST_DSN,
    )
    assert settings.require_production_safety() == []
