"""The single-instance ceiling as /health reports it (plan 0021 M4).

The point of these tests is that each number is *measured*, not declared: the
presence count comes from real accepted sockets, the queue depth from jobs
actually reserved on the queue the app holds, and the budget headroom from
tokens actually recorded. A counter that agrees with a hand-built fixture but
not with the live component would be worse than no counter, because an operator
would act on it.

`app/capacity.py` explains why there is no replica count here and why the
instance id is what replaces it; the two instance-id tests below are the ones
that make that substitute trustworthy — an id minted per request or per app
object would make "two polls, two ids" mean nothing.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.capacity import INSTANCE_ID
from app.main import create_app
from app.rag.budget import DailyTokenBudget, _DayUsage
from app.rag.queue import EmbedJob, EmbedQueue
from app.ws.manager import ConnectionManager

ALICE = {"X-User-Id": "alice"}


def _capacity(client) -> dict:
    res = client.get("/health")
    assert res.status_code == 200
    return res.json()["capacity"]


def _project(client) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    return client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]


def test_quiet_instance_reports_zeroes_and_full_headroom(client):
    capacity = _capacity(client)
    assert capacity["presence"] == {"rooms": 0, "connections": 0}
    assert capacity["queue"] == {"depth": 0, "projects": 0}
    budget = capacity["budget"]
    assert budget["busiest_workspace_tokens"] == 0
    assert budget["workspaces_charged_today"] == 0
    assert budget["managed_daily_limit"] == budget["headroom_tokens"] > 0
    assert budget["headroom_fraction"] == 1.0


def test_components_are_ordered_by_what_breaks_first(client):
    """Budget, then presence, then the queue — the order plan 0021 M4 says to
    fix them in (money, then a visibly wrong answer, then a silent one). The
    payload is the shortest documentation of that ordering an operator reads."""
    keys = [k for k in _capacity(client) if k in {"budget", "presence", "queue"}]
    assert keys == ["budget", "presence", "queue"]


def test_instance_id_is_minted_once_per_process(client):
    """Stable across polls, and the *same* value a second app object reports:
    what it identifies is the process holding the in-memory state, so an
    external monitor seeing it change learns "restarted", and seeing two values
    concurrently learns "two replicas". Either meaning is lost if it is minted
    per request or per app."""
    first = _capacity(client)
    second = _capacity(client)
    assert first["instance_id"] == second["instance_id"] == INSTANCE_ID
    assert first["instance_started_at"] == second["instance_started_at"]

    with TestClient(create_app()) as other:
        assert _capacity(other)["instance_id"] == INSTANCE_ID


def test_presence_counts_real_sockets(client):
    project_id = _project(client)
    with client.websocket_connect(f"/ws/projects/{project_id}/presence?user_id=alice") as ws:
        ws.receive_json()  # the roster broadcast on join — the socket is now in the room
        assert _capacity(client)["presence"] == {"rooms": 1, "connections": 1}
    assert _capacity(client)["presence"] == {"rooms": 0, "connections": 0}


def test_presence_occupancy_counts_sockets_not_users():
    """Two tabs are two sockets in one room, and `roster()` de-duplicates by
    user while this must not: the constraint being reported is how much state
    the process is holding."""
    manager = ConnectionManager(max_per_project=10)
    manager._rooms = {"p1": {object(): None, object(): None}, "p2": {object(): None}}
    assert manager.occupancy() == (2, 3)


def test_queue_depth_counts_every_project(client):
    """Swaps in a fresh queue for the same reason test_index_status.py does:
    `embed_worker_loop` bound the original before its loop, so this one is not
    raced by the running worker."""
    queue = EmbedQueue()
    client.app.state.embed_queue = queue
    jobs = [
        EmbedJob(workspace_id="w1", project_id="p1", node_type="requirements", node_id="r1"),
        EmbedJob(workspace_id="w1", project_id="p1", node_type="requirements", node_id="r2"),
        EmbedJob(workspace_id="w1", project_id="p2", node_type="requirements", node_id="r3"),
    ]
    for job in jobs:
        queue.put_nowait(job)

    assert _capacity(client)["queue"] == {"depth": 3, "projects": 2}

    for job in jobs:
        queue.complete(job)
    assert _capacity(client)["queue"] == {"depth": 0, "projects": 0}


def test_budget_headroom_follows_the_busiest_workspace(client):
    budget: DailyTokenBudget = client.app.state.token_budget
    limit = _capacity(client)["budget"]["managed_daily_limit"]

    budget.record("w1", 1_000)
    budget.record("w2", 4_000)
    budget.record("w1", 500)

    reported = _capacity(client)["budget"]
    assert reported["busiest_workspace_tokens"] == 4_000
    assert reported["headroom_tokens"] == limit - 4_000
    assert reported["headroom_fraction"] == round((limit - 4_000) / limit, 4)
    assert reported["workspaces_charged_today"] == 2


def test_budget_peak_ignores_a_previous_day(client):
    """Nothing prunes a rolled-over entry — `remaining()` filters by day, and so
    must this, or yesterday's heaviest workspace would keep reporting today's
    headroom as exhausted."""
    budget = DailyTokenBudget()
    budget._usage["stale"] = _DayUsage(day="2000-01-01", used=999_999)
    assert budget.peak_usage_today() == (0, 0)

    budget.record("w1", 7)
    assert budget.peak_usage_today() == (7, 1)


def test_existing_health_fields_are_untouched(client):
    """The capacity block is additive: `metrics` is a different thing (work
    done, monotonic) and the plan's own §2.6 curl already depends on this
    response's shape."""
    body = client.get("/health").json()
    assert set(body["metrics"]) == {"pushed", "pulled", "merged", "conflicts"}
    assert body["status"] == "ok"
    assert "schema_version" in body
