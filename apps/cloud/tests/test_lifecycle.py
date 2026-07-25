"""Project lifecycle: planning -> pending_tech_review -> tech_review ->
repo_created (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md,
"Project Lifecycle & Cloud<->Desktop Coordination"). This plan only
implements the default status and the business-user "Send to Tech Lead"
transition — later sub-projects own the rest of the state machine.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app

ALICE = {"X-User-Id": "alice"}


def _client() -> TestClient:
    app = create_app()
    return TestClient(app)


def test_new_project_defaults_to_planning():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        assert project["lifecycle_status"] == "planning"
        assert project["repo_url"] is None
        assert project["repo_default_branch"] is None
