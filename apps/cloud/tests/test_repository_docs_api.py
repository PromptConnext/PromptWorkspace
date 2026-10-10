"""GET .../repository/docs-status and POST .../repository/sync-docs.

After a project's repository exists, its stage documents stay editable and
the seeded copies in the repository drift. The status route compares the
rebuilt seed against the default branch's tree by git blob sha; the sync
route writes the changed views to a `pw/sync-docs-*` branch and opens (or
updates) one pull request. It never writes to the default branch.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient, GithubWriteError
from app.main import create_app
from app.models.schemas import Role

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
TOKEN = "github_pat_11ABCDEF_secretvalue"

STAGE_DOCS = {
    "specify": "# Scope\n\nA story-time app for families.\n",
    "constitution": "# Rules\n\n## Conventions\n\nUse small pull requests.\n",
    "plan": "# Architecture\n\nNext.js front end, FastAPI back end.\n",
    "tasks": "# Tasks\n\n- [ ] T001 Build the reader\n",
}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _workspace(client: TestClient) -> str:
    return client.post("/workspaces", json={"name": "Acme"}, headers=ALICE).json()["id"]


def _connect(client: TestClient, ws_id: str, owner: str = "acme", token: str = TOKEN):
    return client.put(
        f"/workspaces/{ws_id}/integrations/github",
        json={"owner": owner, "token": token},
        headers=ALICE,
    )


def _write_stage(client: TestClient, pid: str, stage: str, content: str) -> None:
    res = client.patch(
        f"/projects/{pid}/stage-documents/{stage}", json={"content": content}, headers=ALICE
    )
    assert res.status_code == 200, res.text


def _created_project(client: TestClient, stages: tuple[str, ...] = tuple(STAGE_DOCS)) -> str:
    ws_id = _workspace(client)
    assert _connect(client, ws_id).status_code == 200
    pid = client.post(
        "/projects", json={"name": "Story Time", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    for stage in stages:
        _write_stage(client, pid, stage, STAGE_DOCS[stage])
    client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")
    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["lifecycle_status"] == "repo_created"
    return pid


def _fake(client: TestClient) -> FakeGithubClient:
    return client.app.state.github_client


def _repo_name(client: TestClient) -> str:
    return _fake(client).commits[0]["repo"]


def _status(client: TestClient, pid: str, headers: dict = ALICE) -> dict:
    res = client.get(f"/projects/{pid}/repository/docs-status", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def _states(body: dict) -> dict[str, str]:
    return {f["path"]: f["state"] for f in body["files"]}


def _sync(client: TestClient, pid: str, headers: dict = ALICE):
    return client.post(f"/projects/{pid}/repository/sync-docs", headers=headers)


def test_status_is_current_right_after_creation(client: TestClient):
    pid = _created_project(client)

    body = _status(client, pid)

    states = _states(body)
    assert states, body
    assert set(states.values()) == {"current"}
    assert {"AGENTS.md", "README.md", "docs/architecture.md"} <= set(states)
    assert body["open_sync_pr"] is None


def test_status_stays_current_on_a_later_day(client: TestClient, monkeypatch):
    """The seed footer carries no date: a status read the day after creation
    must not report every document as changed."""
    pid = _created_project(client)

    class _Tomorrow(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(days=1)

    # raising=False: the seed module no longer needs `datetime` at all.
    monkeypatch.setattr("app.integrations.repo_seed.datetime", _Tomorrow, raising=False)

    states = _states(_status(client, pid))
    assert states and set(states.values()) == {"current"}


def test_editing_the_plan_marks_docs_architecture_out_of_date(client: TestClient):
    pid = _created_project(client)

    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")

    states = _states(_status(client, pid))
    assert states["docs/architecture.md"] == "out_of_date"
    assert {p: s for p, s in states.items() if p != "docs/architecture.md"} == {
        p: "current" for p in states if p != "docs/architecture.md"
    }


def test_missing_documents_are_skipped_not_reported(client: TestClient):
    pid = _created_project(client, stages=("specify", "constitution", "tasks"))

    states = _states(_status(client, pid))

    assert "docs/architecture.md" not in states
    assert set(states.values()) == {"current"}


def test_hand_edited_file_is_reported_and_goes_in_the_pr(client: TestClient):
    pid = _created_project(client)
    fake = _fake(client)
    full_name = _repo_name(client)
    head = asyncio.run(fake.get_branch_head(TOKEN, full_name, "main"))
    fake.sha_files[head]["AGENTS.md"] = "hand edited"

    assert _states(_status(client, pid))["AGENTS.md"] == "out_of_date"

    res = _sync(client, pid)
    assert res.status_code == 200, res.text
    assert "AGENTS.md" in res.json()["files"]
    assert "AGENTS.md" in fake.commits[-1]["paths"]
    body = fake.pull_requests[0]["body"]
    assert "AGENTS.md" in body
    assert "edited by hand" in body


def test_sync_opens_one_pr_with_only_changed_docs(client: TestClient):
    pid = _created_project(client)
    fake = _fake(client)
    full_name = _repo_name(client)
    main_head = fake.branch_heads[full_name]
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")

    res = _sync(client, pid)

    assert res.status_code == 200, res.text
    out = res.json()
    assert "docs/architecture.md" in out["files"]
    assert "AGENTS.md" not in out["files"] and "docs/scope.md" not in out["files"]
    assert out["branch"].startswith("pw/sync-docs-")
    assert len(fake.pull_requests) == 1
    pr = fake.pull_requests[0]
    assert pr["state"] == "open" and pr["head"] == out["branch"] and pr["base"] == "main"
    assert out["pr_number"] == pr["number"] and out["pr_url"] == pr["html_url"]
    assert fake.commits[-1]["branch"] == out["branch"]
    assert fake.commits[-1]["paths"] == out["files"]
    assert fake.branch_heads[full_name] == main_head

    status = _status(client, pid)
    assert status["open_sync_pr"] == {"number": pr["number"], "url": pr["html_url"]}


def test_second_sync_updates_the_same_pull_request(client: TestClient):
    pid = _created_project(client)
    fake = _fake(client)
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")
    first = _sync(client, pid)
    assert first.status_code == 200, first.text
    first_body = fake.pull_requests[0]["body"]
    assert "docs/scope.md" not in first_body
    _write_stage(client, pid, "plan", "# Architecture\n\nQueue worker and a cache.\n")
    _write_stage(client, pid, "specify", "# Scope\n\nStory time for schools too.\n")

    second = _sync(client, pid)

    assert second.status_code == 200, second.text
    assert len(fake.pull_requests) == 1
    assert second.json()["pr_number"] == first.json()["pr_number"]
    assert second.json()["branch"] == first.json()["branch"]
    sync_commits = [c for c in fake.commits if c["branch"] == first.json()["branch"]]
    assert len(sync_commits) == 2
    full_name = _repo_name(client)
    assert f"update_pull_request:{full_name}:1" in fake.call_log
    assert "docs/scope.md" in second.json()["files"]
    updated_body = fake.pull_requests[0]["body"]
    assert "docs/scope.md" in updated_body
    assert updated_body != first_body
    branch_head = fake.branch_refs[(full_name, first.json()["branch"])]
    assert fake.sha_files[branch_head]["docs/architecture.md"].startswith(
        "# Architecture\n\nQueue worker and a cache."
    )


def test_synced_files_read_in_pull_request_and_a_second_click_is_409(client: TestClient):
    pid = _created_project(client)
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")
    assert _sync(client, pid).status_code == 200

    states = _states(_status(client, pid))
    assert states["docs/architecture.md"] == "in_pull_request"
    assert {s for p, s in states.items() if p != "docs/architecture.md"} == {"current"}

    again = _sync(client, pid)
    assert again.status_code == 409
    assert again.json()["detail"] == "repository_docs_current"
    assert len(_fake(client).pull_requests) == 1


def test_editing_another_doc_after_a_sync_commits_only_that_doc(client: TestClient):
    pid = _created_project(client)
    fake = _fake(client)
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")
    first = _sync(client, pid).json()
    _write_stage(client, pid, "specify", "# Scope\n\nStory time for schools too.\n")

    states = _states(_status(client, pid))
    assert states["docs/scope.md"] == "out_of_date"
    assert states["docs/architecture.md"] == "in_pull_request"

    res = _sync(client, pid)

    assert res.status_code == 200, res.text
    # README.md carries the Specify text too, so it changes with docs/scope.md;
    # docs/architecture.md is already on the branch and is not committed again.
    assert res.json()["files"] == ["README.md", "docs/scope.md"]
    assert res.json()["branch"] == first["branch"]
    assert fake.commits[-1]["branch"] == first["branch"]
    assert fake.commits[-1]["paths"] == ["README.md", "docs/scope.md"]
    body = fake.pull_requests[0]["body"]
    assert "docs/scope.md" in body and "docs/architecture.md" in body
    assert set(_states(_status(client, pid)).values()) == {"current", "in_pull_request"}


def test_an_unreadable_sync_branch_falls_back_to_the_default_branch(client: TestClient):
    pid = _created_project(client)
    fake = _fake(client)
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")
    branch = _sync(client, pid).json()["branch"]
    branch_head = fake.branch_refs[(_repo_name(client), branch)]
    real_entries = fake.get_tree_entries

    async def failing_on_the_branch(token, repo, sha, *, recursive=True):
        if sha == branch_head:
            raise GithubWriteError("fake branch read failure", status_code=500)
        return await real_entries(token, repo, sha, recursive=recursive)

    fake.get_tree_entries = failing_on_the_branch

    body = _status(client, pid)
    assert _states(body)["docs/architecture.md"] == "out_of_date"
    assert body["open_sync_pr"] is not None


def test_sync_when_nothing_changed_is_409(client: TestClient):
    pid = _created_project(client)

    res = _sync(client, pid)

    assert res.status_code == 409
    assert res.json()["detail"] == "repository_docs_current"
    assert _fake(client).pull_requests == []


def test_deployment_files_are_never_in_the_pr(client: TestClient):
    pid = _created_project(client)
    fake = _fake(client)
    full_name = _repo_name(client)
    head = fake.branch_heads[full_name]
    # Hand edits to template-owned files must not pull them into the sync.
    fake.sha_files[head][".github/workflows/deploy.yml"] = "on: push\n"
    fake.sha_files[head]["site/index.html"] = "<html></html>"
    fake.sha_files[head]["docs/deployment.md"] = "# Deploy\n"
    for stage, content in STAGE_DOCS.items():
        _write_stage(client, pid, stage, content + "\nRevised.\n")

    res = _sync(client, pid)

    assert res.status_code == 200, res.text
    committed = [p for c in fake.commits[1:] for p in c["paths"]]
    assert committed
    assert not any(p.startswith(".github/") or p.startswith("site/") for p in committed)
    assert "docs/deployment.md" not in committed
    paths = {f["path"] for f in _status(client, pid)["files"]}
    assert not any(p.startswith(".github/") or p.startswith("site/") for p in paths)


def test_token_without_pull_request_permission(client: TestClient, caplog):
    pid = _created_project(client)
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")
    fake = _fake(client)
    fake.fail_pr_status = 403

    with caplog.at_level(logging.WARNING, logger="promptworkspace.repository_docs"):
        res = _sync(client, pid)

    assert res.status_code == 400
    assert res.json()["detail"] == "github_pr_permission_denied"
    # The branch and its commit stay behind (accepted); the warning names it so
    # an operator can find it.
    (orphan,) = [b for (_, b) in fake.branch_refs if b.startswith("pw/sync-docs-")]
    assert any(orphan in r.getMessage() for r in caplog.records)


def test_sync_is_admin_only_and_status_is_member_readable(client: TestClient):
    pid = _created_project(client)
    ws_id = client.get(f"/projects/{pid}", headers=ALICE).json()["workspace_id"]
    client.app.state.repository.add_member(ws_id, "bob", Role.member, invited_by="alice")
    _write_stage(client, pid, "plan", "# Architecture\n\nNow with a queue worker.\n")

    assert client.get(f"/projects/{pid}/repository/docs-status", headers=BOB).status_code == 200
    res = _sync(client, pid, headers=BOB)
    assert res.status_code == 403
    assert _fake(client).pull_requests == []


def test_not_created_and_imported_projects_are_refused(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id)
    planning = client.post(
        "/projects", json={"name": "Draft", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]

    for res in (
        client.get(f"/projects/{planning}/repository/docs-status", headers=ALICE),
        _sync(client, planning),
    ):
        assert res.status_code == 409
        assert res.json()["detail"] == "repository_not_created"

    imported = client.post(
        "/projects", json={"name": "Brought", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    repository = client.app.state.repository
    repository.update_project_repo(
        imported, "https://github.com/acme/brought", 4242, "main", repo_origin="imported"
    )
    repository.update_project_lifecycle_status(imported, "repo_created")

    for res in (
        client.get(f"/projects/{imported}/repository/docs-status", headers=ALICE),
        _sync(client, imported),
    ):
        assert res.status_code == 409
        assert res.json()["detail"] == "sync_not_supported_for_imported_repository"


def test_legacy_imported_project_without_an_origin_is_refused(client: TestClient):
    """A project imported before `repo_origin` existed reaches `repo_created`
    with no recorded origin. Nothing tells it apart from a legacy scratch
    project, so it reads as imported (the migration's NULL-as-imported rule)."""
    ws_id = _workspace(client)
    _connect(client, ws_id)
    legacy = client.post(
        "/projects", json={"name": "Old import", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    repository = client.app.state.repository
    repository.update_project_repo(legacy, "https://github.com/acme/old-import", 4343, "main")
    repository.update_project_lifecycle_status(legacy, "repo_created")
    assert repository.get_project(legacy).repo_origin is None

    for res in (
        client.get(f"/projects/{legacy}/repository/docs-status", headers=ALICE),
        _sync(client, legacy),
    ):
        assert res.status_code == 409
        assert res.json()["detail"] == "sync_not_supported_for_imported_repository"
