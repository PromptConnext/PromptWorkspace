"""Stage apply groups tasks into delivery changes (plan 0029 M1): manual saves
of tasks.md go through the same apply_stage_content as generation."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import GraphUpsertRequest, Requirement, SpecDocument

ALICE = {"X-User-Id": "alice"}

PHASED = """# Tasks

Enough prose here for the document parser's minimum-length check to accept this as a
real generated document rather than a token stub.

## Phase 1: Setup
- [ ] T001 Create the project
## Phase 2: User Story 1 - Book a slot (Priority: P1)
- [ ] T002 Implement booking
- [ ] T003 [P] Booking contract test
## Phase 3: Polish
- [ ] T004 README
"""


def _project_with_spec(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    pid = client.post("/projects", json={"name": "P", "workspace_id": ws["id"]},
                      headers=ALICE).json()["id"]
    repo = client.app.state.repository
    requirement = Requirement(project_id=pid, title="Booking")
    repo.upsert_graph(pid, GraphUpsertRequest(requirements=[requirement]), source="pz")
    spec = SpecDocument(project_id=pid, requirement_id=requirement.id, content="# Spec")
    repo.upsert_graph(pid, GraphUpsertRequest(spec_documents=[spec]), source="pz")
    return ws["id"], pid


def _save_tasks(client: TestClient, pid: str, content: str):
    res = client.patch(f"/projects/{pid}/stage-documents/tasks", json={"content": content},
                       headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["projection"] == "current", res.text
    return res


def _live_tasks(client: TestClient, pid: str):
    return {t.feature_tag.split()[0]: t for t in client.app.state.repository.get_graph(pid).tasks}


def test_saving_a_phased_tasks_document_creates_changes_and_stamps_tasks():
    with TestClient(create_app()) as client:
        _, pid = _project_with_spec(client)
        _save_tasks(client, pid, PHASED)

        changes = client.app.state.repository.list_delivery_changes(pid)
        assert [(c.ref, c.key) for c in changes] == [
            ("C1", "setup"), ("C2", "story:1"), ("C3", "polish"),
        ]
        by_key = {c.key: c.id for c in changes}
        tasks = _live_tasks(client, pid)
        assert tasks["T001"].change_id == by_key["setup"]
        assert tasks["T002"].change_id == by_key["story:1"]
        assert tasks["T003"].change_id == by_key["story:1"]
        assert tasks["T004"].change_id == by_key["polish"]


def test_regeneration_moves_a_task_between_changes_and_keeps_change_ids():
    with TestClient(create_app()) as client:
        _, pid = _project_with_spec(client)
        _save_tasks(client, pid, PHASED)
        first = {c.key: c.id for c in client.app.state.repository.list_delivery_changes(pid)}

        moved = PHASED.replace("- [ ] T004 README\n", "").replace(
            "- [ ] T001 Create the project\n", "- [ ] T001 Create the project\n- [ ] T004 README\n"
        )
        _save_tasks(client, pid, moved)

        second = {c.key: c.id for c in client.app.state.repository.list_delivery_changes(pid)}
        assert second == {"setup": first["setup"], "story:1": first["story:1"]}
        assert _live_tasks(client, pid)["T004"].change_id == first["setup"]


def test_a_flat_legacy_checklist_lands_in_one_unphased_change():
    flat = PHASED.split("## Phase 1")[0] + "- [ ] T001 a\n- [ ] T002 b\n"
    with TestClient(create_app()) as client:
        _, pid = _project_with_spec(client)
        _save_tasks(client, pid, flat)

        (change,) = client.app.state.repository.list_delivery_changes(pid)
        assert change.key == "unphased"
        assert {t.change_id for t in _live_tasks(client, pid).values()} == {change.id}


def test_an_unavailable_delivery_store_still_writes_the_tasks(monkeypatch):
    from app.db.repository import DeliveryStoreUnavailable

    with TestClient(create_app()) as client:
        _, pid = _project_with_spec(client)

        def boom(*_a, **_k):
            raise DeliveryStoreUnavailable()

        monkeypatch.setattr(client.app.state.repository, "upsert_delivery_changes", boom)
        _save_tasks(client, pid, PHASED)

        tasks = _live_tasks(client, pid)
        assert len(tasks) == 4
        assert {t.change_id for t in tasks.values()} == {None}
