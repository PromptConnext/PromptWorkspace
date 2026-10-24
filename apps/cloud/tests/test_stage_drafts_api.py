"""Stage drafts a local agent submits for an imported project, and the human
accept/reject that decides whether they become the project's stage documents."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.integrations.task_refs import task_ref_from_feature_tag
from app.main import create_app
from tests.test_repo_analysis_api import (
    ALICE,
    BOB,
    _agent_analysis,
    _imported_project,
    _scratch_project,
)

SPEC = "# Story pagination\n\nReaders page through long story lists.\n"
PLAN = "# Plan\n\nAdd cursor pagination to the Express routes.\n"
TASKS = (
    "# Tasks\n\n"
    "## Phase 1: Pagination\n"
    "- [ ] T001 Change `src/server.js`\n"
    "  - AC: lists are paged\n"
    "- [ ] T002 Add `src/lib/cursor.js` (new)\n"
)


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _submit(client: TestClient, pid: str, stage: str, markdown: str, headers=ALICE, **extra):
    return client.post(
        f"/projects/{pid}/stage-drafts",
        json={"stage": stage, "markdown": markdown, **extra},
        headers=headers,
    )


def _current_id(client: TestClient, pid: str, stage: str) -> str:
    """The id of the stage's draft as the human sees it, or a placeholder so
    the route's own 404 answers when there is none."""
    draft = client.app.state.repository.get_stage_draft(pid, stage)
    return draft.id if draft is not None else "no-draft"


def _accept(
    client: TestClient, pid: str, stage: str, headers=ALICE, draft_id: str | None = None, **extra
):
    body = {"draft_id": draft_id or _current_id(client, pid, stage), **extra}
    return client.post(f"/projects/{pid}/stage-drafts/{stage}/accept", json=body, headers=headers)


def _reject(
    client: TestClient,
    pid: str,
    stage: str,
    note: str = "",
    headers=ALICE,
    draft_id: str | None = None,
):
    body = {"draft_id": draft_id or _current_id(client, pid, stage), "note": note}
    return client.post(f"/projects/{pid}/stage-drafts/{stage}/reject", json=body, headers=headers)


def _ready_project(client: TestClient) -> tuple[str, str]:
    ws_id, pid = _imported_project(client)
    assert _agent_analysis(client, pid).status_code == 200
    return ws_id, pid


def _accepted(client: TestClient, pid: str, stage: str, markdown: str) -> None:
    assert _submit(client, pid, stage, markdown).status_code == 201
    res = _accept(client, pid, stage)
    assert res.status_code == 200, res.text
    assert res.json()["projection"] in ("current", "not_applicable")


# --------------------------------------------------------------------------- #
# Submit
# --------------------------------------------------------------------------- #


def test_submit_stores_a_pending_draft_and_returns_task_warnings(client: TestClient):
    _, pid = _ready_project(client)
    markdown = (
        "# Tasks\n\n"
        "## Phase 1: Pagination\n"
        "- [ ] T001 Change `src/server.js`\n"
        "- [ ] T003 Add pagination in `src/lib/paginate.js`\n"
    )
    res = _submit(client, pid, "tasks", markdown, model="claude-opus-5-5")
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["status"] == "pending"
    assert body["source"] == "agent"
    assert body["model"] == "claude-opus-5-5"
    assert body["markdown"] == markdown
    assert body["created_by"] == "alice"
    assert body["stale"] is False
    warnings = {w["code"]: w["items"] for w in body["warnings"]}
    assert set(warnings) == {"missing_task_numbers", "unmarked_new_paths"}
    assert warnings["missing_task_numbers"] == ["T002"]
    assert warnings["unmarked_new_paths"] == [{"ref": "T003", "path": "src/lib/paginate.js"}]

    repo = client.app.state.repository
    assert repo.get_stage_document(pid, "tasks") is None
    stored = repo.get_stage_draft(pid, "tasks")
    assert stored is not None and stored.markdown == markdown


def test_submit_of_a_clean_document_has_no_warnings(client: TestClient):
    _, pid = _ready_project(client)
    res = _submit(client, pid, "tasks", TASKS)
    assert res.status_code == 201 and res.json()["warnings"] == []


def test_submit_respects_per_stage_access(client: TestClient):
    _, pid = _imported_project(client)
    assert _submit(client, pid, "constitution", "# r", headers=BOB).status_code == 403
    assert _submit(client, pid, "plan", "# p", headers=BOB).status_code == 403
    assert _submit(client, pid, "specify", "# s", headers=BOB).status_code == 201
    assert _submit(client, pid, "tasks", "# t", headers=BOB).status_code == 201
    mallory = {"X-User-Id": "mallory"}
    assert _submit(client, pid, "specify", "# s", headers=mallory).status_code == 403


def test_submit_validates_its_body(client: TestClient):
    _, pid = _imported_project(client)
    assert _submit(client, pid, "specify", "").status_code == 422
    assert _submit(client, pid, "deploy", "# d").status_code == 422
    assert _submit(client, pid, "specify", "x" * 100_001).status_code == 422


def test_resubmit_replaces_and_clears_rejection_and_error(client: TestClient):
    _, pid = _imported_project(client)
    first = _submit(client, pid, "specify", "# One").json()
    assert _reject(client, pid, "specify", "Too vague").status_code == 200
    repo = client.app.state.repository
    rejected = repo.get_stage_draft(pid, "specify")
    repo.upsert_stage_draft(rejected.model_copy(update={"last_error": "boom"}))

    second = _submit(client, pid, "specify", "# Two")
    assert second.status_code == 201
    body = second.json()
    assert body["id"] != first["id"]
    assert (body["status"], body["rejection_note"], body["last_error"]) == ("pending", None, None)
    stored = repo.get_stage_draft(pid, "specify")
    assert stored.markdown == "# Two" and stored.status == "pending"
    assert len(repo.list_stage_drafts(pid)) == 1


def test_submit_refused_for_scratch_and_created_projects(client: TestClient):
    _, scratch = _scratch_project(client)
    res = _submit(client, scratch, "specify", "# s")
    assert res.status_code == 409 and res.json()["detail"] == "repo_not_imported"

    _, pid = _imported_project(client)
    client.app.state.repository.update_project_lifecycle_status(pid, "repo_created")
    res = _submit(client, pid, "specify", "# s")
    assert res.status_code == 409 and res.json()["detail"] == "repo_already_created"


# --------------------------------------------------------------------------- #
# Accept
# --------------------------------------------------------------------------- #


def test_accept_without_a_draft_is_404(client: TestClient):
    _, pid = _ready_project(client)
    res = _accept(client, pid, "specify")
    assert res.status_code == 404 and res.json()["detail"] == "draft_not_found"


def test_accept_of_a_rejected_draft_is_404(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "specify", SPEC)
    _reject(client, pid, "specify", "No")
    res = _accept(client, pid, "specify")
    assert res.status_code == 404 and res.json()["detail"] == "draft_not_found"
    assert client.app.state.repository.get_stage_document(pid, "specify") is None


def test_accept_plan_without_a_requirement_saves_nothing(client: TestClient):
    _, pid = _ready_project(client)
    assert _submit(client, pid, "plan", PLAN).status_code == 201
    res = _accept(client, pid, "plan")
    assert res.status_code == 409 and res.json()["detail"] == "requirement_required"
    repo = client.app.state.repository
    assert repo.get_stage_document(pid, "plan") is None
    assert repo.get_stage_draft(pid, "plan") is not None


def test_accept_tasks_without_a_spec_document_saves_nothing(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "tasks", TASKS)
    res = _accept(client, pid, "tasks")
    assert res.status_code == 409 and res.json()["detail"] == "spec_document_required"
    assert client.app.state.repository.get_stage_document(pid, "tasks") is None


def test_accept_plan_and_tasks_wait_for_a_baseline(client: TestClient):
    _, pid = _imported_project(client)
    _accepted(client, pid, "specify", SPEC)
    _submit(client, pid, "plan", PLAN)
    res = _accept(client, pid, "plan")
    assert res.status_code == 409 and res.json()["detail"] == "repo_analysis_required"
    _submit(client, pid, "tasks", TASKS)
    res = _accept(client, pid, "tasks")
    assert res.status_code == 409 and res.json()["detail"] == "repo_analysis_required"


def test_accept_applies_through_the_shared_path_and_records_source(client: TestClient):
    _, pid = _ready_project(client)
    repo = client.app.state.repository
    assert repo.get_latest_requirement(pid) is None

    assert _submit(client, pid, "specify", SPEC).status_code == 201
    res = _accept(client, pid, "specify")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["projection"] == "current" and body["stage"] == "specify"
    assert body["content"] == SPEC

    requirement = repo.get_latest_requirement(pid)
    assert requirement is not None and requirement.title == "Story pagination"
    document = repo.get_stage_document(pid, "specify")
    assert document.content == SPEC and document.source == "agent"
    assert repo.get_stage_draft(pid, "specify") is None


def test_accept_through_to_tasks_builds_the_board(client: TestClient):
    _, pid = _ready_project(client)
    _accepted(client, pid, "specify", SPEC)
    _accepted(client, pid, "plan", PLAN)
    repo = client.app.state.repository
    assert repo.get_latest_spec_document(pid) is not None

    assert _submit(client, pid, "tasks", TASKS).status_code == 201
    res = _accept(client, pid, "tasks")
    assert res.status_code == 200, res.text
    assert res.json()["projection"] == "current"
    live = [t for t in repo.get_graph(pid).tasks if t.deleted_at is None]
    # Refs are stored normalised (T001 -> T1).
    assert sorted(task_ref_from_feature_tag(t.feature_tag) for t in live) == ["T1", "T2"]
    assert all(t.spec_id == repo.get_latest_spec_document(pid).id for t in live)
    assert repo.get_stage_document(pid, "tasks").source == "agent"
    assert repo.list_stage_drafts(pid) == []


def test_accept_constitution_is_admin_only(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "constitution", "# Rules\n\nBe kind.")
    assert _accept(client, pid, "constitution", headers=BOB).status_code == 403
    res = _accept(client, pid, "constitution")
    assert res.status_code == 200 and res.json()["projection"] == "not_applicable"
    assert client.app.state.repository.get_stage_draft(pid, "constitution") is None


def test_accept_keeps_the_draft_when_projection_fails(client: TestClient):
    _, pid = _ready_project(client)
    _accepted(client, pid, "specify", SPEC)
    _accepted(client, pid, "plan", PLAN)
    markdown = "# Tasks\n\nNothing to do yet.\n"
    _submit(client, pid, "tasks", markdown)

    res = _accept(client, pid, "tasks")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["projection"] == "failed" and body["error"]

    repo = client.app.state.repository
    assert repo.get_stage_document(pid, "tasks").content == markdown
    draft = repo.get_stage_draft(pid, "tasks")
    assert draft is not None and draft.status == "pending"
    assert draft.last_error == body["error"]


def test_accept_honours_the_intent_gate(client: TestClient):
    _, pid = _ready_project(client)
    _accepted(client, pid, "specify", SPEC)
    asked = client.post(
        f"/projects/{pid}/decisions", json={"kind": "intent_approval"}, headers=BOB
    )
    assert asked.status_code == 200, asked.text
    _submit(client, pid, "plan", PLAN)

    res = _accept(client, pid, "plan")
    assert res.status_code == 409 and res.json()["detail"] == "intent_not_approved"
    assert client.app.state.repository.get_stage_document(pid, "plan") is None


# --------------------------------------------------------------------------- #
# Reject and list
# --------------------------------------------------------------------------- #


def test_reject_keeps_the_note_for_the_brief(client: TestClient):
    _, pid = _imported_project(client)
    _submit(client, pid, "specify", SPEC)
    res = _reject(client, pid, "specify", "Name the pagination style.")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "rejected"
    assert body["rejection_note"] == "Name the pagination style."
    assert body["warnings"] == []

    listed = client.get(f"/projects/{pid}/stage-drafts", headers=ALICE).json()
    assert [(d["stage"], d["status"]) for d in listed] == [("specify", "rejected")]

    brief = client.get(f"/projects/{pid}/planning-brief", headers=ALICE).json()
    assert [(d["stage"], d["status"], d["rejection_note"]) for d in brief["drafts"]] == [
        ("specify", "rejected", "Name the pagination style.")
    ]


def test_reject_with_no_note_stores_none(client: TestClient):
    _, pid = _imported_project(client)
    _submit(client, pid, "specify", SPEC)
    assert _reject(client, pid, "specify").json()["rejection_note"] is None


def test_reject_needs_a_draft_and_stage_access(client: TestClient):
    _, pid = _imported_project(client)
    res = _reject(client, pid, "specify")
    assert res.status_code == 404 and res.json()["detail"] == "draft_not_found"
    _submit(client, pid, "plan", PLAN)
    assert _reject(client, pid, "plan", headers=BOB).status_code == 403
    assert client.app.state.repository.get_stage_draft(pid, "plan").status == "pending"


def test_list_is_member_readable_and_computes_stale(client: TestClient):
    _, pid = _imported_project(client)
    _submit(client, pid, "constitution", "# Rules")
    _submit(client, pid, "specify", SPEC)

    listed = client.get(f"/projects/{pid}/stage-drafts", headers=BOB)
    assert listed.status_code == 200, listed.text
    by_stage = {d["stage"]: d for d in listed.json()}
    assert set(by_stage) == {"constitution", "specify"}
    assert by_stage["specify"]["markdown"] == SPEC
    assert by_stage["specify"]["stale"] is False
    assert by_stage["specify"]["warnings"] == []

    client.patch(
        f"/projects/{pid}/stage-documents/constitution",
        json={"content": "# Rules moved"},
        headers=ALICE,
    )
    by_stage = {
        d["stage"]: d for d in client.get(f"/projects/{pid}/stage-drafts", headers=BOB).json()
    }
    assert by_stage["specify"]["stale"] is True
    assert by_stage["constitution"]["stale"] is False

    assert client.get(
        f"/projects/{pid}/stage-drafts", headers={"X-User-Id": "mallory"}
    ).status_code == 403


def test_one_sitting_drafts_are_not_stale_after_their_predecessors_are_accepted(
    client: TestClient,
):
    """The agent submits all four drafts in one sitting, each against the
    previous *draft*; accepting the drafts in order must not mark the later
    ones stale. Only a change to the predecessor's content does."""
    _, pid = _ready_project(client)
    rules = "# Rules\n\nBe kind.\n"
    for stage, markdown in (
        ("constitution", rules),
        ("specify", SPEC),
        ("plan", PLAN),
        ("tasks", TASKS),
    ):
        assert _submit(client, pid, stage, markdown).status_code == 201

    def stale() -> dict[str, bool]:
        listed = client.get(f"/projects/{pid}/stage-drafts", headers=ALICE).json()
        return {d["stage"]: d["stale"] for d in listed}

    assert _accept(client, pid, "constitution").status_code == 200
    assert stale()["specify"] is False
    assert _accept(client, pid, "specify").status_code == 200
    assert stale()["plan"] is False
    assert _accept(client, pid, "plan").status_code == 200
    assert stale()["tasks"] is False

    res = client.patch(
        f"/projects/{pid}/stage-documents/plan",
        json={"content": PLAN + "\nAlso cache the first page.\n"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert stale()["tasks"] is True

    assert _submit(client, pid, "tasks", TASKS).status_code == 201
    assert stale()["tasks"] is False


def test_accepting_the_predecessor_after_editing_its_draft_marks_the_successor_stale(
    client: TestClient,
):
    _, pid = _ready_project(client)
    _accepted(client, pid, "constitution", "# Rules\n")
    assert _submit(client, pid, "specify", SPEC).status_code == 201
    assert _submit(client, pid, "plan", PLAN).status_code == 201
    res = client.patch(
        f"/projects/{pid}/stage-documents/specify",
        json={"content": SPEC + "\nReaders may also filter.\n"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    listed = {
        d["stage"]: d["stale"]
        for d in client.get(f"/projects/{pid}/stage-drafts", headers=ALICE).json()
    }
    assert listed["plan"] is True


# --------------------------------------------------------------------------- #
# Accept and reject address the draft the human read, by id
# --------------------------------------------------------------------------- #


def test_accept_and_reject_require_a_draft_id(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "specify", SPEC)
    url = f"/projects/{pid}/stage-drafts/specify"
    assert client.post(f"{url}/accept", json={}, headers=ALICE).status_code == 422
    assert client.post(f"{url}/reject", json={"note": "x"}, headers=ALICE).status_code == 422


def test_accept_of_a_replaced_draft_is_409_and_saves_nothing(client: TestClient):
    _, pid = _ready_project(client)
    opened = _submit(client, pid, "specify", SPEC).json()["id"]
    newer = _submit(client, pid, "specify", "# Something else\n").json()["id"]

    res = _accept(client, pid, "specify", draft_id=opened)
    assert res.status_code == 409 and res.json()["detail"] == "draft_changed"
    repo = client.app.state.repository
    assert repo.get_stage_document(pid, "specify") is None
    assert repo.get_latest_requirement(pid) is None
    current = repo.get_stage_draft(pid, "specify")
    assert current.id == newer and current.status == "pending"


def test_reject_of_a_replaced_draft_is_409_and_keeps_it_pending(client: TestClient):
    _, pid = _ready_project(client)
    opened = _submit(client, pid, "specify", SPEC).json()["id"]
    _submit(client, pid, "specify", "# Something else\n")

    res = _reject(client, pid, "specify", "No", draft_id=opened)
    assert res.status_code == 409 and res.json()["detail"] == "draft_changed"
    current = client.app.state.repository.get_stage_draft(pid, "specify")
    assert current.status == "pending" and current.rejection_note is None


def test_delete_stage_draft_is_guarded_by_id(client: TestClient):
    _, pid = _ready_project(client)
    first = _submit(client, pid, "specify", SPEC).json()["id"]
    _submit(client, pid, "specify", "# Newer\n")
    repo = client.app.state.repository
    assert repo.delete_stage_draft(pid, "specify", draft_id=first) is False
    assert repo.get_stage_draft(pid, "specify") is not None


# --------------------------------------------------------------------------- #
# The reviewer edits the draft in the stage editor before accepting it
# --------------------------------------------------------------------------- #


def test_accept_applies_the_reviewers_edited_markdown(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "specify", SPEC)
    edited = "# Story pagination\n\nReaders page through lists, 20 at a time.\n"

    res = _accept(client, pid, "specify", markdown=edited)
    assert res.status_code == 200, res.text
    assert res.json()["content"] == edited
    repo = client.app.state.repository
    document = repo.get_stage_document(pid, "specify")
    assert document.content == edited and document.source == "agent"
    assert repo.get_stage_draft(pid, "specify") is None


def test_accept_with_blank_markdown_applies_the_draft(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "specify", SPEC)
    res = _accept(client, pid, "specify", markdown="   \n")
    assert res.status_code == 200, res.text
    assert client.app.state.repository.get_stage_document(pid, "specify").content == SPEC


def test_accept_caps_the_edited_markdown(client: TestClient):
    _, pid = _ready_project(client)
    _submit(client, pid, "specify", SPEC)
    res = _accept(client, pid, "specify", markdown="x" * 100_001)
    assert res.status_code == 422
    repo = client.app.state.repository
    assert repo.get_stage_document(pid, "specify") is None
    assert repo.get_stage_draft(pid, "specify").status == "pending"


# --------------------------------------------------------------------------- #
# Parse warnings on submit
# --------------------------------------------------------------------------- #


def test_a_tasks_draft_of_prose_only_warns_no_task_lines(client: TestClient):
    _, pid = _ready_project(client)
    res = _submit(client, pid, "tasks", "# Tasks\n\nWe will add pagination soon.\n")
    assert res.status_code == 201, res.text
    codes = [w["code"] for w in res.json()["warnings"]]
    assert codes == ["no_task_lines"]


def test_a_draft_with_nothing_left_after_parsing_warns_empty_document(client: TestClient):
    _, pid = _ready_project(client)
    res = _submit(client, pid, "specify", "<think>only thinking</think>")
    assert res.status_code == 201, res.text
    assert [w["code"] for w in res.json()["warnings"]] == ["empty_document"]


def test_a_well_formed_specification_has_no_warnings(client: TestClient):
    _, pid = _ready_project(client)
    res = _submit(client, pid, "specify", SPEC)
    assert res.json()["warnings"] == []
