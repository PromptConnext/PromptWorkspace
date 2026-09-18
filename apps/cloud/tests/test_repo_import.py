"""Repo-import onboarding gate: the listing route (GET .../github/repos), the
import path through POST /projects, and adoption at create-repository.

Three-part design, each pinned separately here:
  - listing is member-gated (the gate exists for business users, not admins)
    and always filters by the connected owner, never trusting GitHub's own
    scoping of /user/repos;
  - POST /projects with import_repo_full_name records repo_url immediately
    but leaves lifecycle_status at "planning" — policy scope and deployment
    template stay selectable, same as a from-scratch project;
  - create_repository, once the project reaches tech_review, adopts the
    recorded repo instead of creating one, reusing the same _adopt_repo path
    the create/retry collision already exercises.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import Role

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
TOKEN = "github_pat_11ABCDEF_secretvalue"


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


def _seed_repo(
    client: TestClient,
    full_name: str,
    *,
    default_branch: str = "main",
    private: bool = True,
    archived: bool = False,
    empty: bool = False,
    pushed_at: str | None = "2026-09-15T00:00:00Z",
) -> None:
    """Populate FakeGithubClient.existing_repos with the raw shape _repo_row
    normalizes, so list_repos and get_repo both see it."""
    client.app.state.github_client.existing_repos[full_name] = {
        "full_name": full_name,
        "html_url": f"https://github.com/{full_name}",
        "default_branch": default_branch,
        "private": private,
        "archived": archived,
        "size": 0 if empty else 100,
        "pushed_at": pushed_at,
    }


# --------------------------------------------------------------------------- #
# Listing
# --------------------------------------------------------------------------- #


def test_listing_filters_out_a_repo_under_a_different_owner(client: TestClient):
    """The safety net for unverified /user/repos scoping: even if GitHub
    returned a repo outside the connected owner, it must never reach the
    picker — the platform's PAT cannot write to it."""
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp")
    _seed_repo(client, "someone-else/other-repo")

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert res.status_code == 200, res.text
    full_names = [r["full_name"] for r in res.json()["repositories"]]
    assert full_names == ["acme/storyapp"]


def test_listing_reports_owner_even_when_empty(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    body = res.json()
    assert body["repositories"] == []
    assert body["owner"] == "acme"


def test_listing_allows_a_non_admin_member(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    client.app.state.repository.add_member(ws_id, "bob", Role.member, invited_by="alice")

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=BOB)
    assert res.status_code == 200, res.text


def test_listing_forbidden_for_non_member(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=BOB)
    assert res.status_code == 403


def test_listing_without_a_connection(client: TestClient):
    ws_id = _workspace(client)
    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "github_not_configured"


def test_listing_401_reports_token_rejected(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    client.app.state.github_client.list_repos_failure_status = 401

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "github_token_rejected"


def test_listing_surfaces_truncated(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    client.app.state.github_client.list_repos_truncated = True

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert res.json()["truncated"] is True


def test_listing_rate_limited(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    limiter = client.app.state.github_read_limiter
    limiter.per_minute = 1
    limiter.burst = 1

    first = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert first.status_code == 200, first.text
    second = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert second.status_code == 429
    assert second.json()["detail"] == "github_rate_limited"


# --------------------------------------------------------------------------- #
# POST /projects with import_repo_full_name
# --------------------------------------------------------------------------- #


def test_import_records_repo_from_get_repo_not_the_client(client: TestClient):
    """default_branch is "master" here specifically so a hardcoded "main"
    fails the assertion — the value must come from the live GitHub read."""
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp", default_branch="master")

    res = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["repo_url"] == "https://github.com/acme/storyapp"
    assert body["repo_default_branch"] == "master"


def test_import_leaves_lifecycle_at_planning(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp")

    project = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    ).json()
    assert project["lifecycle_status"] == "planning"

    # Policy scope must still be settable, same as a from-scratch project.
    res = client.patch(
        f"/projects/{project['id']}/policy-scope",
        json={"selected": ["thai-pdpa"], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text


def test_no_import_field_is_byte_identical_to_today(client: TestClient):
    ws_id = _workspace(client)
    res = client.post("/projects", json={"name": "Plain", "workspace_id": ws_id}, headers=ALICE)
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["repo_url"] is None
    assert body["lifecycle_status"] == "planning"


def test_import_owner_mismatch(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "someone-else/storyapp")

    res = client.post(
        "/projects",
        json={
            "name": "Story App",
            "workspace_id": ws_id,
            "import_repo_full_name": "someone-else/storyapp",
        },
        headers=ALICE,
    )
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "repo_owner_out_of_scope"


def test_import_unknown_repo(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")

    res = client.post(
        "/projects",
        json={"name": "Ghost", "workspace_id": ws_id, "import_repo_full_name": "acme/ghost"},
        headers=ALICE,
    )
    assert res.status_code == 404, res.text
    assert res.json()["detail"] == "repo_not_found"


def test_import_403_reports_token_scope(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    client.app.state.github_client.get_repo_failure_status = 403

    res = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "github_repo_not_in_token_scope"


def test_import_duplicate_repo_in_same_workspace(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp")

    first = client.post(
        "/projects",
        json={"name": "First", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert first.status_code == 201, first.text

    second = client.post(
        "/projects",
        json={"name": "Second", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == "repo_already_imported"


def test_import_empty_repo_refused(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp", empty=True)

    res = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "repo_is_empty"


def test_import_without_github_connected(client: TestClient):
    ws_id = _workspace(client)
    res = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "github_not_configured"


def test_import_invalid_full_name_shape(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")

    res = client.post(
        "/projects",
        json={
            "name": "Story App",
            "workspace_id": ws_id,
            "import_repo_full_name": "not-a-repo-name",
        },
        headers=ALICE,
    )
    assert res.status_code == 422, res.text


# --------------------------------------------------------------------------- #
# Adoption at create_repository
# --------------------------------------------------------------------------- #


def test_imported_project_adopts_at_create_repository(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp", default_branch="master")
    client.app.state.settings.public_api_url = "https://api.test"

    project = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    ).json()
    pid = project["id"]
    client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["lifecycle_status"] == "repo_created"

    fake = client.app.state.github_client
    assert fake.created_repos == []
    assert not any(entry.startswith("create_repo:") for entry in fake.call_log)
    assert fake.commits[0]["branch"] == "master"

    # Secrets/webhook-before-commit ordering still holds on the import path —
    # nothing else guards it once creation is no longer the only way in.
    commit_index = fake.call_log.index("commit:acme/storyapp")
    webhook_index = fake.call_log.index("webhook:acme/storyapp")
    assert webhook_index < commit_index


def test_imported_repo_deleted_before_tech_review_exit(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp")

    project = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    ).json()
    pid = project["id"]
    client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

    # The repo vanished from GitHub between import and tech-review exit.
    del client.app.state.github_client.existing_repos["acme/storyapp"]

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "imported_repo_not_found"

    unchanged = client.get(f"/projects/{pid}", headers=ALICE).json()
    assert unchanged["lifecycle_status"] == "tech_review"
