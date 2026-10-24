"""The planning brief a local agent fetches before drafting an imported
project's planning documents."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.generation.prompts import _template
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import Document, StageDraft
from tests.test_repo_analysis_api import (
    ALICE,
    BOB,
    _imported_project,
    _scratch_project,
)


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _brief(client: TestClient, pid: str, headers=ALICE):
    return client.get(f"/projects/{pid}/planning-brief", headers=headers)


def _add_prd(client: TestClient, ws_id: str, pid: str, title: str, text: str | None):
    repo = client.app.state.repository
    doc = Document(
        workspace_id=ws_id,
        project_id=pid,
        title=title,
        mime="text/plain",
        storage_ref="x",
        extracted_text=text,
        created_by="alice",
    )
    repo.create_document(doc)


def test_brief_carries_templates_policy_prds_and_submittable_stages(client: TestClient):
    ws_id, pid = _imported_project(client)
    _add_prd(client, ws_id, pid, "PRD one", "y" * 50_000)
    _add_prd(client, ws_id, pid, "Unread scan", None)

    res = _brief(client, pid)
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["templates"]) == {"constitution", "specify", "plan", "tasks"}
    assert body["templates"]["tasks"] == _template("tasks-template-existing.md")
    assert body["templates"]["constitution"] == _template("constitution-template.md")
    assert body["submittable_stages"] == ["constitution", "specify", "plan", "tasks"]
    assert body["analysis_status"] == "none"
    assert body["baseline"] == ""
    assert body["drafts"] == []
    assert body["project_id"] == pid
    assert body["project_name"] == "Story App"
    assert body["prd_texts"] == [{"title": "PRD one", "text": "y" * 40_000}]
    assert "submit_stage_draft" in body["instructions"]
    assert "- [ ] T001 [P]" in body["instructions"]
    assert body["default_branch"] == "main"
    assert body["repo_url"] == "https://github.com/acme/storyapp"
    assert body["can_submit_analysis"] is True


def test_brief_lists_only_member_stages_for_a_member(client: TestClient):
    _, pid = _imported_project(client)
    body = _brief(client, pid, BOB).json()
    assert body["submittable_stages"] == ["specify", "tasks"]
    assert body["can_submit_analysis"] is False


def test_brief_refuses_scratch_and_created_projects(client: TestClient):
    _, scratch = _scratch_project(client)
    res = _brief(client, scratch)
    assert res.status_code == 409 and res.json()["detail"] == "repo_not_imported"

    _, pid = _imported_project(client)
    client.app.state.repository.update_project_lifecycle_status(pid, "repo_created")
    res = _brief(client, pid)
    assert res.status_code == 409 and res.json()["detail"] == "repo_already_created"


def test_brief_refuses_a_non_member(client: TestClient):
    _, pid = _imported_project(client)
    assert _brief(client, pid, {"X-User-Id": "mallory"}).status_code == 403


def test_brief_marks_a_draft_stale_when_its_predecessor_moved(client: TestClient):
    """Stale is a fingerprint, not a timestamp: a draft written against the
    constitution "# d" stays fresh when that exact text is saved as the
    document, and turns stale once the document says something else."""
    from app.api.stage_drafts import predecessor_fingerprint

    ws_id, pid = _imported_project(client)
    repo = client.app.state.repository
    for stage in ("constitution", "specify"):
        repo.upsert_stage_draft(
            StageDraft(
                project_id=pid,
                workspace_id=ws_id,
                stage=stage,
                markdown="# d",
                predecessor_fingerprint=predecessor_fingerprint(repo, pid, stage),
                created_by="alice",
            )
        )
    before = {d["stage"]: d["stale"] for d in _brief(client, pid).json()["drafts"]}
    assert before == {"constitution": False, "specify": False}

    res = client.patch(
        f"/projects/{pid}/stage-documents/constitution", json={"content": "# d"}, headers=ALICE
    )
    assert res.status_code == 200, res.text
    same = {d["stage"]: d["stale"] for d in _brief(client, pid).json()["drafts"]}
    assert same == {"constitution": False, "specify": False}

    res = client.patch(
        f"/projects/{pid}/stage-documents/constitution",
        json={"content": "# Constitution moved"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    after = {d["stage"]: d["stale"] for d in _brief(client, pid).json()["drafts"]}
    assert after == {"constitution": False, "specify": True}


def test_compute_stale_without_a_predecessor_document_is_false(client: TestClient):
    from app.api.stage_drafts import compute_stale

    ws_id, pid = _imported_project(client)
    repo = client.app.state.repository
    draft = StageDraft(
        project_id=pid, workspace_id=ws_id, stage="plan", markdown="# p", created_by="alice"
    )
    assert compute_stale(draft, repo) is False
