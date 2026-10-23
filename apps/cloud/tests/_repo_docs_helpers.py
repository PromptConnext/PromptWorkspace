"""Helpers for tests of a project whose repository already exists.

Shared by test_repository_docs_api.py and test_plan_edit_after_repository.py:
a workspace with a connected GitHub token, a project with stage documents
written, taken through create-repository against a FakeGithubClient so its
lifecycle is `repo_created`.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.models.schemas import DeploymentConfig

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
TOKEN = "github_pat_11ABCDEF_secretvalue"

STAGE_DOCS = {
    "specify": "# Scope\n\nA story-time app for families.\n",
    "constitution": "# Rules\n\n## Conventions\n\nUse small pull requests.\n",
    "plan": "# Architecture\n\nNext.js front end, FastAPI back end.\n",
    "tasks": "# Tasks\n\n- [ ] T001 Build the reader\n",
}


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


def _created_project(
    client: TestClient,
    stages: tuple[str, ...] = tuple(STAGE_DOCS),
    template_id: str | None = None,
) -> str:
    ws_id = _workspace(client)
    assert _connect(client, ws_id).status_code == 200
    pid = client.post(
        "/projects", json={"name": "Story Time", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    for stage in stages:
        _write_stage(client, pid, stage, STAGE_DOCS[stage])
    if template_id is not None:
        # As tests/test_lifecycle.py::_with_template: the platform-hosted
        # template needs a public base URL to seed at all.
        client.app.state.repository.update_project_deployment_config(
            pid, DeploymentConfig(template_id=template_id)
        )
        client.app.state.settings.deploy_r2_public_base_url = "https://preview.test"
    client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")
    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["lifecycle_status"] == "repo_created"
    return pid
