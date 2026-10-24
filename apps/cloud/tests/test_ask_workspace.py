"""Ask the workspace (plan 0033 task 20)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api.ask import ASK_SYSTEM_PROMPT
from app.main import create_app
from app.models.schemas import (
    Decision,
    ModelConnection,
    ProjectCardOut,
    WorkspaceOverviewOut,
    utcnow,
)
from app.overview.facts import compute_workspace_facts, facts_to_text
from app.rag.chat import FakeChatProvider

ALICE = {"X-User-Id": "alice"}


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def workspace(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    return ws["id"]


def _card(
    pid: str,
    name: str,
    hats: dict,
    overdue: int = 0,
    runtime: str | None = None,
    expired: int = 0,
):
    now = utcnow()
    return ProjectCardOut(
        id=pid, name=name, lifecycle_status="planning", updated_at=now, hats=hats,
        contributors=[], task_counts={}, decisions={"open": 0, "overdue": overdue,
                                                     "expired_30d": expired},
        stack={"runtime": runtime} if runtime else None, policy={}, checks=[],
        agent_closed_30d=3, last_activity_at=now,
    )


def _overview(cards):
    return WorkspaceOverviewOut(
        workspace_id="w", generated_at=utcnow(), members=[], projects=cards
    )


def _decision(project_id: str) -> Decision:
    return Decision(
        project_id=project_id, workspace_id="w", kind="plan_approval", title="t",
        subject_stage="specify", subject_hash="h", routed_hat="tech_steward",
        requested_by="bob",
    )


def test_facts_my_open_decisions_only_routed_to_me():
    ov = _overview([_card("p1", "Alpha", {"business_owner": "a", "tech_steward": "a"})])
    facts = compute_workspace_facts(ov, [_decision("p1")])
    assert [d.project_name for d in facts.my_open_decisions] == ["Alpha"]
    assert "1 decision waiting" in facts_to_text(facts)
    empty = compute_workspace_facts(ov, [])
    assert empty.my_open_decisions == []
    assert "no decisions waiting" in facts_to_text(empty)


def test_facts_projects_missing_hats():
    ov = _overview(
        [
            _card("p1", "Alpha", {"business_owner": "a", "tech_steward": None}, overdue=2,
                  runtime="python"),
            _card("p2", "Beta", {"business_owner": "a", "tech_steward": "b"}, runtime="python"),
        ]
    )
    facts = compute_workspace_facts(ov, [])
    assert [(p.name, p.hats) for p in facts.projects_missing_hats] == [
        ("Alpha", ["tech_steward"])
    ]
    assert facts.overdue[0].count == 2
    assert facts.by_runtime == {"python": ["Alpha", "Beta"]}
    assert facts.agent_closed_30d == 6


def test_facts_expired_decisions_listed_per_project():
    ov = _overview(
        [
            _card("p1", "Alpha", {"business_owner": "a", "tech_steward": "a"}, expired=1),
            _card("p2", "Beta", {"business_owner": "a", "tech_steward": "a"}),
        ]
    )
    facts = compute_workspace_facts(ov, [])
    assert [(e.name, e.count) for e in facts.expired] == [("Alpha", 1)]
    assert "Decisions expired without an answer: Alpha (1)." in facts_to_text(facts)
    none = facts_to_text(compute_workspace_facts(_overview([_card("p2", "B", {})]), []))
    assert "expired" not in none


def _events(text: str) -> list[tuple[str, str]]:
    out = []
    for frame in text.split("\n\n"):
        if not frame.strip():
            continue
        event, data = "message", ""
        for line in frame.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()
        out.append((event, data))
    return out


def test_ask_without_model_streams_facts_only(client: TestClient, workspace: str):
    res = client.post(f"/workspaces/{workspace}/ask", json={"question": "hi"}, headers=ALICE)
    assert res.status_code == 200
    events = _events(res.text)
    assert [e for e, _ in events] == ["facts", "done"]
    assert client.app.state.repository._generation_runs == {}


def test_ask_with_fake_provider_streams_deltas_and_records_run(
    client: TestClient, workspace: str
):
    client.app.state.chat_provider = FakeChatProvider()
    client.app.state.managed_connection = ModelConnection(
        workspace_id="managed", provider="typhoon", base_url="https://x/v1", model="m",
        embed_model="", embed_dim=0, secret_ref="unused", daily_token_budget=20_000,
        created_by="platform", source="managed",
    )
    client.app.state.secret_store.decrypt = lambda _ref: "k"
    res = client.post(
        f"/workspaces/{workspace}/ask", json={"question": "what is waiting?"}, headers=ALICE
    )
    events = _events(res.text)
    assert events[0][0] == "facts" and events[-1][0] == "done"
    deltas = [json.loads(d)["delta"] for e, d in events if e == "message"]
    assert deltas
    runs = list(client.app.state.repository._generation_runs.values())
    assert len(runs) == 1
    assert runs[0].stage == "ask:workspace" and runs[0].project_id is None
    assert runs[0].completion_tokens > 0


def test_ask_rejects_long_question(client: TestClient, workspace: str):
    res = client.post(
        f"/workspaces/{workspace}/ask", json={"question": "x" * 501}, headers=ALICE
    )
    assert res.status_code == 422


def _managed(client: TestClient, budget: int = 20_000) -> None:
    client.app.state.managed_connection = ModelConnection(
        workspace_id="managed", provider="typhoon", base_url="https://x/v1", model="m",
        embed_model="", embed_dim=0, secret_ref="unused", daily_token_budget=budget,
        created_by="platform", source="managed",
    )
    client.app.state.secret_store.decrypt = lambda _ref: "k"


class _Capture:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    async def stream_chat(self, context, question, model, api_key, base_url, system_prompt=None):
        self.calls.append((context, question, system_prompt))
        yield "ok"


def test_ask_sends_only_facts_and_the_exact_system_prompt(client: TestClient, workspace: str):
    pid = client.post(
        "/projects", json={"name": "Alpha", "workspace_id": workspace}, headers=ALICE
    ).json()["id"]
    client.app.state.repository.save_decision(
        Decision(
            project_id=pid, workspace_id=workspace, kind="plan_approval",
            title="SECRET-TITLE", subject_stage="specify", subject_hash="h",
            subject_content="SECRET-DOC-TEXT", routed_hat="tech_steward",
            requested_by="bob",
        )
    )
    cap = _Capture()
    client.app.state.chat_provider = cap
    _managed(client)
    res = client.post(f"/workspaces/{workspace}/ask", json={"question": "q?"}, headers=ALICE)
    assert res.status_code == 200
    [(context, question, system_prompt)] = cap.calls
    assert system_prompt == ASK_SYSTEM_PROMPT
    assert question == "q?"
    facts = _events(res.text)[0][1]
    from app.models.schemas import WorkspaceFacts
    assert context == facts_to_text(WorkspaceFacts.model_validate_json(facts))
    assert "plan_approval" in context
    assert "SECRET" not in context and "SECRET" not in facts


def test_ask_with_exhausted_budget_streams_facts_only(client: TestClient, workspace: str):
    _managed(client, budget=100)
    client.app.state.chat_provider = _Capture()
    client.app.state.token_budget.record(workspace, 100)
    res = client.post(f"/workspaces/{workspace}/ask", json={"question": "q"}, headers=ALICE)
    assert [e for e, _ in _events(res.text)] == ["facts", "done"]
    assert client.app.state.repository._generation_runs == {}
    assert client.app.state.chat_provider.calls == []
