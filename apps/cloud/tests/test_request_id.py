"""The request id and the JSON log line that carries it (plan 0021 M3).

The deliverable is a value an operator can grep for, so these tests assert on
the two places it has to appear — the response header and the serialised log
line — rather than on the middleware's internals. The log assertions attach
the real `JsonLogFormatter` + `RequestIdFilter` to a handler and parse what
comes out with `json.loads`, which is also the manual "does the output look
reasonable" check, run automatically.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import uuid
from io import StringIO
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.queue import EmbedJob, EmbedQueue, embed_worker_loop, enqueue
from app.requestlog import (
    REQUEST_ID_HEADER,
    JsonLogFormatter,
    RequestIdFilter,
    get_request_id,
)

ALICE = {"X-User-Id": "alice"}

_UUID4 = re.compile(
    r"\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z", re.IGNORECASE
)


@pytest.fixture
def log_lines():
    """A handler wired exactly as `configure_logging` wires the root one.

    Attached to the `promptworkspace` logger rather than root, so pytest's own
    capture is untouched and this is independent of whether `basicConfig` did
    anything in this process.
    """
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonLogFormatter())
    handler.addFilter(RequestIdFilter())
    logger = logging.getLogger("promptworkspace")
    previous_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        yield lambda: [json.loads(line) for line in stream.getvalue().splitlines() if line]
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)


def _app_that_logs() -> FastAPI:
    """Production app plus two routes that log, one sync and one async.

    Both shapes matter: a sync FastAPI handler runs in a worker thread, so the
    contextvar only reaches it because anyio copies the context into that
    thread — worth an assertion rather than an assumption, since most handlers
    in this service are sync.
    """
    app = create_app()
    logger = logging.getLogger("promptworkspace.test")

    @app.get("/__test__/logs-sync")
    def logs_sync() -> dict:
        logger.info("sync handler ran")
        return {"request_id": get_request_id()}

    @app.get("/__test__/logs-async")
    async def logs_async() -> dict:
        logger.info("async handler ran")
        return {"request_id": get_request_id()}

    return app


# --------------------------------------------------------------------------
# 1. The header, in both directions.
# --------------------------------------------------------------------------


def test_a_request_without_the_header_gets_one_minted_and_echoed(client: TestClient):
    res = client.get("/health")
    assert res.status_code == 200
    assert _UUID4.match(res.headers[REQUEST_ID_HEADER]), res.headers.get(REQUEST_ID_HEADER)


def test_two_requests_get_different_ids(client: TestClient):
    first = client.get("/health").headers[REQUEST_ID_HEADER]
    second = client.get("/health").headers[REQUEST_ID_HEADER]
    assert first != second


def test_a_client_supplied_id_is_echoed_back_unchanged(client: TestClient):
    """The caller's value wins, or `apiFetch`'s id would be useless: the
    browser would hold one value and the logs another."""
    sent = "a1b2c3d4-0000-4000-8000-abcdefabcdef"
    res = client.get("/health", headers={REQUEST_ID_HEADER: sent})
    assert res.headers[REQUEST_ID_HEADER] == sent


@pytest.mark.parametrize(
    "hostile",
    [
        # Forged log records: with a raw formatter this would end a line and
        # start another that looks like ours.
        'x\n{"level": "ERROR", "message": "forged"}',
        "\r\nX-Injected: 1",
        "a" * 400,  # unbounded growth in every log line of the request
        "",  # present but empty
        "not a token; it has spaces",
    ],
)
def test_an_unacceptable_client_id_is_replaced_not_sanitised(hostile: str, client: TestClient):
    """The header is untrusted input that ends up in a log line. A value
    outside `[A-Za-z0-9._:-]{1,200}` is dropped for a minted one — quietly
    mangling it would be worse, and echoing it would be worse still."""
    res = client.get("/health", headers={REQUEST_ID_HEADER: hostile})
    echoed = res.headers[REQUEST_ID_HEADER]
    assert _UUID4.match(echoed)
    assert echoed != hostile.strip()


def test_the_id_header_is_exposed_to_browser_javascript(client: TestClient):
    """A response header is unreadable from JS unless CORS exposes it, and the
    caller needs to read back the id that was actually used."""
    res = client.get(
        "/health", headers={**ALICE, "Origin": "http://localhost:3000"}
    )
    exposed = res.headers.get("access-control-expose-headers", "")
    assert REQUEST_ID_HEADER.lower() in exposed.lower()


def test_error_responses_carry_an_id_too(client: TestClient):
    """A failing call is the one a user reports, so the id has to survive the
    error paths — a routing 404 and a membership 403 are both handled responses
    and both go out through the middleware.

    The exception is the bare 500 Starlette synthesises for an *unhandled*
    exception: it is built above every user middleware, so it carries no
    header, and `tests/test_error_reporting.py::test_the_request_id_lands_as_a_tag`
    covers what correlates that case instead.
    """
    assert client.get("/nope").status_code == 404
    assert _UUID4.match(client.get("/nope").headers[REQUEST_ID_HEADER])

    forbidden = client.get("/workspaces/does-not-exist/members", headers=ALICE)
    assert forbidden.status_code in (403, 404)
    assert _UUID4.match(forbidden.headers[REQUEST_ID_HEADER])


def test_a_rate_limited_response_still_carries_an_id():
    """The middleware is registered outermost on purpose: a 429 short-circuits
    the rate limiter and never reaches a route, and that is precisely the
    response an operator is trying to find in the logs."""
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    try:
        app = create_app()
        app.dependency_overrides = {}
        settings: Settings = get_settings()
        assert settings.rate_limit_enabled, "the limiter is on by default"
        with TestClient(app) as client:
            seen = set()
            statuses = set()
            for _ in range(settings.rate_limit_burst + 3):
                res = client.get("/sync/projects/none/changes", headers=ALICE)
                statuses.add(res.status_code)
                seen.add(res.headers[REQUEST_ID_HEADER])
            assert 429 in statuses, "expected the burst to exhaust the bucket"
            assert len(seen) == settings.rate_limit_burst + 3, "every response got its own id"
    finally:
        get_settings.cache_clear()


# --------------------------------------------------------------------------
# 2. The log line.
# --------------------------------------------------------------------------


def test_records_logged_during_a_request_carry_its_id(log_lines):
    with TestClient(_app_that_logs()) as client:
        sent = "req-from-the-browser-1"
        for route in ("/__test__/logs-sync", "/__test__/logs-async"):
            res = client.get(route, headers={REQUEST_ID_HEADER: sent})
            assert res.json()["request_id"] == sent, route

    logged = [line for line in log_lines() if line["logger"] == "promptworkspace.test"]
    assert len(logged) == 2, logged
    assert {line["message"] for line in logged} == {"sync handler ran", "async handler ran"}
    assert all(line["request_id"] == sent for line in logged), logged


def test_a_json_line_carries_the_fields_a_log_search_filters_on(log_lines):
    logging.getLogger("promptworkspace.test").warning("disk is %s%% full", 91)

    line = log_lines()[-1]
    assert line["level"] == "WARNING"
    assert line["logger"] == "promptworkspace.test"
    assert line["message"] == "disk is 91% full"
    assert line["timestamp"].endswith("Z")
    # Parseable as an instant, not merely string-shaped.
    from datetime import datetime

    assert datetime.fromisoformat(line["timestamp"].replace("Z", "+00:00"))


def test_records_outside_any_request_have_a_null_id(log_lines):
    """Startup, the tombstone GC, a CLI import. `request_id` is present and
    null rather than absent, so a log search can filter on the field."""
    logging.getLogger("promptworkspace.test").info("started")
    try:
        raise RuntimeError("nothing to do with a request")
    except RuntimeError:
        logging.getLogger("promptworkspace.test").exception("startup step failed")

    lines = log_lines()
    assert [line["request_id"] for line in lines] == [None, None]
    assert "RuntimeError: nothing to do with a request" in lines[-1]["exception"]


def test_configure_logging_puts_json_on_the_root_logger(capsys):
    """What `lifespan` actually calls, on a root logger emptied for the test.

    It has to be emptied: `configure_logging` deliberately does not pass
    `force=True` to `basicConfig` (that would evict the `caplog` handler other
    tests assert startup warnings through), so under pytest the call is
    otherwise a no-op. This is the same thing running the app locally and
    hitting an endpoint would show, minus the local run.
    """
    from app.requestlog import configure_logging

    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    root.handlers = []
    try:
        configure_logging("INFO")
        assert any(isinstance(h.formatter, JsonLogFormatter) for h in root.handlers)
        logging.getLogger("promptworkspace").info("PromptWorkspace Cloud %s started", "0.1.0")
        payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
        assert payload["level"] == "INFO"
        assert payload["logger"] == "promptworkspace"
        assert payload["message"] == "PromptWorkspace Cloud 0.1.0 started"
        assert payload["request_id"] is None
        # The DEBUG-noise pin moved into configure_logging with the formatter.
        assert logging.getLogger("httpx").level == logging.WARNING
    finally:
        root.handlers = saved_handlers
        root.setLevel(saved_level)


# --------------------------------------------------------------------------
# 3. Into the background worker.
# --------------------------------------------------------------------------


def test_enqueue_stamps_the_requests_id_onto_the_job():
    """`EmbedJob` is frozen and `enqueue` is the funnel every producer goes
    through, so the stamp lives there — a job enqueued from a request thread
    (which is where the sync upsert path runs) comes out carrying it."""
    app = create_app()
    queue = EmbedQueue()

    @app.post("/__test__/enqueue")
    def enqueue_one() -> dict:
        enqueue(app, EmbedJob("w1", "p1", "requirements", "r1"))
        return {"ok": True}

    with TestClient(app) as client:
        client.app.state.embed_queue = queue
        sent = "req-that-pushed-the-graph"
        client.post("/__test__/enqueue", headers={**ALICE, REQUEST_ID_HEADER: sent})

    job = asyncio.run(queue.get())
    assert job.request_id == sent
    assert job.node_id == "r1", "nothing else about the job changed"


def test_a_job_enqueued_outside_a_request_has_no_id():
    """The model-connection backfill runs on startup. None is the honest
    answer, and `request_id_scope` in the worker must not label it with
    whatever the previous job carried."""
    app = SimpleNamespace(state=SimpleNamespace(embed_queue=EmbedQueue()))
    enqueue(app, EmbedJob("w1", "p1", "requirements", "r1"))

    job = asyncio.run(app.state.embed_queue.get())
    assert job.request_id is None


def test_an_explicitly_stamped_job_keeps_its_own_id():
    app = SimpleNamespace(state=SimpleNamespace(embed_queue=EmbedQueue()))
    enqueue(app, EmbedJob("w1", "p1", "requirements", "r1", request_id="chosen-by-the-caller"))

    assert asyncio.run(app.state.embed_queue.get()).request_id == "chosen-by-the-caller"


def test_the_worker_loops_failure_line_names_the_enqueueing_request(log_lines):
    """The whole point of the field: `embed_worker_loop` reports a failure long
    after the request that queued the work has returned, and `logger.exception`
    there was never taught about request ids — the contextvar rebound around
    the job is what attributes it."""

    class _ExplodingRepository:
        def get_model_connection(self, workspace_id: str):
            raise RuntimeError("embedding provider unavailable")

    app = SimpleNamespace(
        state=SimpleNamespace(embed_queue=EmbedQueue(), repository=_ExplodingRepository())
    )
    job = EmbedJob("w1", "p1", "requirements", "r1", request_id="req-that-uploaded-the-prd")

    async def drain() -> None:
        queue: EmbedQueue = app.state.embed_queue
        queue.put_nowait(job)
        worker = asyncio.create_task(embed_worker_loop(app))
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 5.0
        while queue.pending_for("p1") and loop.time() < deadline:
            await asyncio.sleep(0.01)
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker

    asyncio.run(drain())

    failures = [line for line in log_lines() if line["logger"] == "promptworkspace.rag"]
    assert failures, "the worker should have logged the failure"
    assert failures[-1]["message"] == "embed job failed node=r1 type=requirements"
    assert failures[-1]["request_id"] == "req-that-uploaded-the-prd"
    assert app.state.embed_queue.last_failure_for("p1").code == "embed_failed"
    assert app.state.embed_queue.pending_for("p1") == 0


def test_the_worker_does_not_leak_one_jobs_id_into_the_next(log_lines):
    """One long-lived task drains every job, so the binding has to be reset
    between them — otherwise a backfill job (no request) is reported under the
    request id of whatever ran before it."""

    class _ExplodingRepository:
        def get_model_connection(self, workspace_id: str):
            raise RuntimeError("embedding provider unavailable")

    app = SimpleNamespace(
        state=SimpleNamespace(embed_queue=EmbedQueue(), repository=_ExplodingRepository())
    )
    jobs = [
        EmbedJob("w1", "p1", "requirements", "first", request_id="req-1"),
        EmbedJob("w1", "p1", "requirements", "second"),
    ]

    async def drain() -> None:
        queue: EmbedQueue = app.state.embed_queue
        worker = asyncio.create_task(embed_worker_loop(app))
        loop = asyncio.get_running_loop()
        for job in jobs:
            queue.put_nowait(job)
            deadline = loop.time() + 5.0
            while queue.pending_for("p1") and loop.time() < deadline:
                await asyncio.sleep(0.01)
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker

    asyncio.run(drain())

    failures = [line for line in log_lines() if line["logger"] == "promptworkspace.rag"]
    assert [line["request_id"] for line in failures] == ["req-1", None]


def test_the_minted_id_is_a_uuid():
    """Not an assertion about the format for its own sake: `apiFetch` mints
    `crypto.randomUUID()` on the browser side, and an id an operator sees in
    two places should look the same in both."""
    from app.requestlog import new_request_id

    assert uuid.UUID(new_request_id()).version == 4
