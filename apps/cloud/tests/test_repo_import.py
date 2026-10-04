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

import time

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import DeploymentConfig, Role
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
TOKEN = "github_pat_11ABCDEF_secretvalue"

# _repo_row (app/integrations/github.py) requires "id" unconditionally —
# plan 0016's identity field. Fixtures below don't care about the value,
# only that every seeded repo has a distinct one.
_next_test_repo_id = iter(range(9000, 9999))


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
    created_at: str | None = None,
    size: int | None = None,
    has_commits: bool = False,
) -> None:
    """Populate FakeGithubClient.existing_repos with the raw shape _repo_row
    normalizes, so list_repos and get_repo both see it."""
    client.app.state.github_client.existing_repos[full_name] = {
        "id": next(_next_test_repo_id),
        "full_name": full_name,
        "html_url": f"https://github.com/{full_name}",
        "default_branch": default_branch,
        "private": private,
        "archived": archived,
        "size": size if size is not None else (0 if empty else 100),
        "pushed_at": pushed_at,
        "created_at": created_at,
        "has_commits": has_commits,
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


@pytest.mark.parametrize(
    ("created_at", "pushed_at", "empty"),
    [
        # Pushed 18 s after creation (the marketing-studio case): a commit
        # exists even though GitHub's size is still 0.
        ("2026-10-04T14:55:24Z", "2026-10-04T14:55:42Z", False),
        # Never pushed after creation: GitHub sets pushed_at to created_at.
        ("2026-10-04T14:55:24Z", "2026-10-04T14:55:24Z", True),
        # No timestamps to compare: fall back to size.
        (None, None, True),
    ],
)
def test_listing_overrides_a_lagging_zero_size_with_a_later_push(
    client: TestClient, created_at, pushed_at, empty
):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp", size=0, created_at=created_at, pushed_at=pushed_at)

    res = client.get(f"/workspaces/{ws_id}/integrations/github/repos", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["repositories"][0]["empty"] is empty


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


def test_import_duplicate_repo_across_workspaces_is_generic(client: TestClient):
    """Cross-workspace collision (plan 0016 M5): bob has no membership in
    alice's workspace, so the 409 must not leak its id, name, or project."""
    ws_a = _workspace(client)
    _connect(client, ws_a, owner="acme")
    _seed_repo(client, "acme/storyapp")

    first = client.post(
        "/projects",
        json={"name": "First", "workspace_id": ws_a, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert first.status_code == 201, first.text

    ws_b = client.post("/workspaces", json={"name": "Bobco"}, headers=BOB).json()["id"]
    client.put(
        f"/workspaces/{ws_b}/integrations/github",
        json={"owner": "acme", "token": TOKEN},
        headers=BOB,
    )

    second = client.post(
        "/projects",
        json={"name": "Second", "workspace_id": ws_b, "import_repo_full_name": "acme/storyapp"},
        headers=BOB,
    )
    assert second.status_code == 409, second.text
    body = second.json()
    assert body["detail"] == "repo_already_imported"
    assert ws_a not in str(body)
    assert "First" not in str(body)


def test_import_duplicate_repo_survives_a_rename(client: TestClient):
    """full_name alone can't catch this — id is GitHub's stable identity
    across a rename/transfer (plan 0016 M5)."""
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp")

    first = client.post(
        "/projects",
        json={"name": "First", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert first.status_code == 201, first.text

    # Simulate GitHub renaming the repo: same id, new full_name/key.
    record = client.app.state.github_client.existing_repos.pop("acme/storyapp")
    record["full_name"] = "acme/storyapp-renamed"
    client.app.state.github_client.existing_repos["acme/storyapp-renamed"] = record

    second = client.post(
        "/projects",
        json={
            "name": "Second",
            "workspace_id": ws_id,
            "import_repo_full_name": "acme/storyapp-renamed",
        },
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


def test_import_of_a_fresh_push_whose_size_github_has_not_recomputed(client: TestClient):
    """GitHub's `size` can stay 0 for hours after the first push; the branch
    head is the authority, so the import goes through."""
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    # created_at == pushed_at: the listing heuristic still says empty.
    _seed_repo(client, "acme/storyapp", size=0, has_commits=True,
               created_at="2026-10-04T14:55:24Z", pushed_at="2026-10-04T14:55:24Z")

    res = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text


def test_import_refuses_when_github_cannot_say_whether_the_repo_is_empty(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp", empty=True)
    client.app.state.github_client.get_tree_failure_status = 500

    res = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    )
    assert res.status_code == 502, res.text
    assert res.json()["detail"] == "github_unreachable"


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


# --------------------------------------------------------------------------- #
# Non-destructive seeding of an imported repository (plan 0027 M4)
# --------------------------------------------------------------------------- #

_TEAM_README = "# Story App\n\nOur own README, written by the team."
_TEAM_AGENTS = "Our own agent rules."


def _imported_at_tech_review(
    client: TestClient, tree: list[str], *, template: str | None = None
) -> str:
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    _seed_repo(client, "acme/storyapp")
    fake: FakeGithubClient = client.app.state.github_client
    fake.trees["acme/storyapp"] = list(tree)
    fake.written_files[("acme/storyapp", "README.md")] = _TEAM_README
    fake.written_files[("acme/storyapp", "AGENTS.md")] = _TEAM_AGENTS

    pid = client.post(
        "/projects",
        json={"name": "Story App", "workspace_id": ws_id, "import_repo_full_name": "acme/storyapp"},
        headers=ALICE,
    ).json()["id"]
    repository = client.app.state.repository
    for stage, content in (("constitution", "# Constitution\n\nRules."), ("specify", "# Spec")):
        repository.upsert_stage_document(pid, ws_id, stage, content, "alice")
    if template is not None:
        repository.update_project_deployment_config(pid, DeploymentConfig(template_id=template))
    repository.update_project_lifecycle_status(pid, "tech_review")
    return pid


def test_existing_readme_and_agents_survive_create_repository(client: TestClient):
    """The fake's create_commit_with_files asserts no path in the repo's
    existing tree is written — so a 200 here is itself the proof that
    neither file was overwritten."""
    pid = _imported_at_tech_review(client, ["README.md", "AGENTS.md", "src/server.js"])

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text

    fake = client.app.state.github_client
    written = fake.commits[0]["paths"]
    assert "README.md" not in written
    assert "AGENTS.md" not in written
    assert fake.written_files[("acme/storyapp", "README.md")] == _TEAM_README
    assert fake.written_files[("acme/storyapp", "AGENTS.md")] == _TEAM_AGENTS


def test_derived_docs_land_under_docs_promptworkspace(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md", "AGENTS.md", "src/server.js"])
    client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)

    written = set(client.app.state.github_client.commits[0]["paths"])
    assert {
        "docs/promptworkspace/README.md",
        "docs/promptworkspace/scope.md",
        "docs/promptworkspace/conventions.md",
        # Taken at the root, so moved beside the others.
        "docs/promptworkspace/AGENTS.md",
    } <= written
    # Free in this repository, so written where the tools look for it.
    assert ".specify/memory/constitution.md" in written
    assert not any(
        p.startswith("docs/") and not p.startswith("docs/promptworkspace/") for p in written
    )


def test_an_existing_promptworkspace_folder_is_left_intact(client: TestClient):
    pid = _imported_at_tech_review(
        client, ["README.md", "docs/promptworkspace/README.md", "docs/promptworkspace/scope.md"]
    )
    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text

    written = client.app.state.github_client.commits[0]["paths"]
    assert "docs/promptworkspace/README.md" not in written
    assert "docs/promptworkspace/scope.md" not in written


def test_an_existing_deploy_workflow_refuses_before_anything_is_written(client: TestClient):
    pid = _imported_at_tech_review(
        client, ["README.md", ".github/workflows/deploy.yml"], template="github-pages"
    )
    client.app.state.settings.public_api_url = "https://api.test"

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "deploy_workflow_conflict"

    fake = client.app.state.github_client
    assert fake.commits == []
    assert fake.secrets == {} and fake.variables == {}
    assert not any(e.startswith("webhook:") for e in fake.call_log)
    project = client.get(f"/projects/{pid}", headers=ALICE).json()
    assert project["lifecycle_status"] == "tech_review"


def test_existing_scaffold_files_are_skipped_one_by_one(client: TestClient):
    pid = _imported_at_tech_review(
        client, ["README.md", "site/index.html"], template="github-pages"
    )

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = client.app.state.github_client.commits[0]["paths"]
    assert "site/index.html" not in written
    assert ".github/workflows/deploy.yml" in written
    assert "docs/promptworkspace/deployment.md" in written


def test_seed_preview_matches_the_actual_commit(client: TestClient):
    pid = _imported_at_tech_review(
        client, ["README.md", "AGENTS.md", "site/index.html"], template="github-pages"
    )

    preview = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert {"from": "AGENTS.md", "to": "docs/promptworkspace/AGENTS.md"} in body["relocated"]
    assert {"from": "README.md", "to": "docs/promptworkspace/README.md"} in body["relocated"]
    assert body["skipped"] == ["site/index.html"]
    assert body["conflicts"] == []
    # A preview writes nothing and reads only.
    assert client.app.state.github_client.commits == []

    client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert sorted(body["write"]) == sorted(client.app.state.github_client.commits[0]["paths"])


def test_seed_preview_reports_the_workflow_conflict(client: TestClient):
    pid = _imported_at_tech_review(
        client, [".github/workflows/deploy.yml"], template="github-pages"
    )
    body = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE).json()
    assert body["conflicts"] == [".github/workflows/deploy.yml"]


def test_seed_preview_is_admin_only(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md"])
    ws_id = client.get(f"/projects/{pid}", headers=ALICE).json()["workspace_id"]
    client.app.state.repository.add_member(ws_id, "bob", Role.member, invited_by="alice")

    res = client.get(f"/projects/{pid}/repository/seed-preview", headers=BOB)
    assert res.status_code == 403


def test_scratch_project_seed_is_unchanged(client: TestClient):
    """A repository the platform creates has nothing to protect: the seed
    keeps its root-level paths, and the preview says exactly that."""
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    pid = client.post(
        "/projects", json={"name": "Fresh", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

    preview = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE).json()
    assert preview["relocated"] == [] and preview["skipped"] == [] and preview["conflicts"] == []

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    fake = client.app.state.github_client
    written = fake.commits[0]["paths"]
    assert "README.md" in written and "AGENTS.md" in written
    assert not any(p.startswith("docs/promptworkspace/") for p in written)
    assert sorted(preview["write"]) == sorted(written)
    assert not any(e.startswith("tree:") for e in fake.call_log)


def _crash_window_project(
    client: TestClient, *, origin: str | None, description: str | None = None
) -> str:
    """A from-scratch project whose repo_url was recorded before the seed
    commit landed, the lifecycle still at tech_review."""
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    pid = client.post(
        "/projects", json={"name": "Fresh", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    fake: FakeGithubClient = client.app.state.github_client
    fake.existing_repos["acme/fresh"] = {
        "id": 777,
        "full_name": "acme/fresh",
        "html_url": "https://github.com/acme/fresh",
        "default_branch": "main",
        "description": description or f"PromptWorkspace-managed repository for project {pid}",
    }
    repository = client.app.state.repository
    repository.update_project_repo(
        pid, "https://github.com/acme/fresh", 777, "main", repo_origin=origin
    )
    repository.update_project_lifecycle_status(pid, "tech_review")
    return pid


def test_a_repo_this_project_created_keeps_the_full_seed_on_retry(client: TestClient):
    """The crash-window retry: repo_url recorded, lifecycle still tech_review.
    The server recorded that it created this repository (and its description
    agrees), so the retry must seed it exactly as the first attempt would
    have."""
    pid = _crash_window_project(client, origin="created")

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = client.app.state.github_client.commits[0]["paths"]
    assert "README.md" in written
    assert not any(p.startswith("docs/promptworkspace/") for p in written)


def test_a_spoofed_description_does_not_earn_an_import_the_overwriting_seed(client: TestClient):
    """An imported repository whose admin set its description to the exact
    string the platform writes is still an import: `repo_origin` decides."""
    pid = _imported_at_tech_review(client, ["README.md", "AGENTS.md"])
    fake: FakeGithubClient = client.app.state.github_client
    fake.existing_repos["acme/storyapp"]["description"] = (
        f"PromptWorkspace-managed repository for project {pid}"
    )

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = fake.commits[0]["paths"]
    assert "README.md" not in written and "AGENTS.md" not in written
    assert "docs/promptworkspace/README.md" in written


def test_a_legacy_project_without_an_origin_gets_the_non_destructive_seed(client: TestClient):
    """Predates repo_origin: even with the platform's description, the retry
    cannot tell a crash-window project from an import, so it relocates."""
    pid = _crash_window_project(client, origin=None)

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = client.app.state.github_client.commits[0]["paths"]
    assert "README.md" not in written
    assert "docs/promptworkspace/README.md" in written


def test_a_created_origin_with_a_changed_description_is_not_overwritten(client: TestClient):
    pid = _crash_window_project(client, origin="created", description="Renamed by the team")

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    assert "README.md" not in client.app.state.github_client.commits[0]["paths"]


def test_create_path_records_the_created_origin(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id, owner="acme")
    pid = client.post(
        "/projects", json={"name": "Fresh", "workspace_id": ws_id}, headers=ALICE
    ).json()["id"]
    assert client.get(f"/projects/{pid}", headers=ALICE).json()["repo_origin"] is None
    client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["repo_origin"] == "created"


def test_import_records_the_imported_origin_and_keeps_it(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md"])
    assert client.get(f"/projects/{pid}", headers=ALICE).json()["repo_origin"] == "imported"
    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.json()["repo_origin"] == "imported"


# --------------------------------------------------------------------------- #
# What counts as "already there" (security review of plan 0027)
# --------------------------------------------------------------------------- #


def test_a_truncated_listing_still_protects_every_seed_path(client: TestClient):
    """GitHub cut the recursive listing off before any of the files the seed
    could collide with. The per-directory walk must find them anyway — the
    fake's commit asserts nothing existing is overwritten."""
    tree = [
        "README.md",
        "AGENTS.md",
        "docs/promptworkspace/scope.md",
        *(f"src/m{i}.js" for i in range(50)),
    ]
    pid = _imported_at_tech_review(client, tree)
    fake: FakeGithubClient = client.app.state.github_client
    fake.tree_truncated = True
    fake.truncated_listing["acme/storyapp"] = ["src/m0.js"]

    preview = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE).json()
    assert {"from": "AGENTS.md", "to": "docs/promptworkspace/AGENTS.md"} in preview["relocated"]
    assert "docs/promptworkspace/scope.md" in preview["skipped"]

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = fake.commits[0]["paths"]
    assert "AGENTS.md" not in written and "docs/promptworkspace/scope.md" not in written
    assert sorted(preview["write"]) == sorted(written)


def test_a_truncated_listing_still_finds_a_workflow_conflict(client: TestClient):
    pid = _imported_at_tech_review(
        client, ["README.md", ".github/workflows/deploy.yml"], template="github-pages"
    )
    fake: FakeGithubClient = client.app.state.github_client
    fake.tree_truncated = True

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "deploy_workflow_conflict"


@pytest.mark.parametrize("as_submodule", [True, False])
def test_an_entry_at_docs_keeps_the_seed_out_of_docs(client: TestClient, as_submodule: bool):
    pid = _imported_at_tech_review(client, ["README.md"] if as_submodule else ["README.md", "docs"])
    fake: FakeGithubClient = client.app.state.github_client
    if as_submodule:
        fake.gitlinks["acme/storyapp"] = ["docs"]

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = fake.commits[0]["paths"]
    assert not any(p.startswith("docs/") for p in written)
    assert "AGENTS.md" in written


def test_collisions_ignore_case(client: TestClient):
    pid = _imported_at_tech_review(client, ["readme.md", "agents.md"])

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    written = client.app.state.github_client.commits[0]["paths"]
    assert "AGENTS.md" not in written
    assert "docs/promptworkspace/AGENTS.md" in written


def test_a_workflow_differing_only_in_case_is_a_conflict(client: TestClient):
    pid = _imported_at_tech_review(
        client, ["README.md", ".github/workflows/Deploy.yml"], template="github-pages"
    )
    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "deploy_workflow_conflict"


def test_a_push_between_the_check_and_the_commit_refuses_the_seed(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md"])
    fake: FakeGithubClient = client.app.state.github_client
    fake.branch_heads["acme/storyapp"] = "checked-head"
    fake.branch_head_on_commit["acme/storyapp"] = "someone-elses-push"

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "repo_moved_during_seed"
    assert fake.commits == []
    project = client.get(f"/projects/{pid}", headers=ALICE).json()
    assert project["lifecycle_status"] == "tech_review"

    # The retry reads the new head and seeds against it.
    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text


# --------------------------------------------------------------------------- #
# Initial code index (plan 0027 M5)
# --------------------------------------------------------------------------- #


def _with_model_connection(client: TestClient, pid: str) -> str:
    ws_id = client.get(f"/projects/{pid}", headers=ALICE).json()["workspace_id"]
    client.app.state.embedding_provider = FakeEmbeddingProvider()
    res = client.post(
        f"/workspaces/{ws_id}/model-connection",
        json={
            "provider": "openai",
            "base_url": "https://api.example.com/v1",
            "model": "gpt-x",
            "embed_model": "embed-x",
            "api_key": "sk-test",
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    return ws_id


def _indexed_paths(client: TestClient, ws_id: str, pid: str) -> set[str]:
    zero = [0.0] * FakeEmbeddingProvider.dim
    hits = client.app.state.repository.code_vector_search(ws_id, pid, zero, top_k=100)
    return {h.path for h in hits}


def _wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_repo_created_indexes_the_imported_code(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md", "src/server.js", ".env", "yarn.lock"])
    ws_id = _with_model_connection(client, pid)
    fake = client.app.state.github_client
    fake.branch_heads["acme/storyapp"] = "pre-seed-head"
    fake.set_file("acme/storyapp", "src/server.js", "pre-seed-head", "const app = express();\n")

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text

    assert _wait_until(lambda: {"README.md", "src/server.js"} <= _indexed_paths(client, ws_id, pid))
    fetched = {(path, sha) for _repo, path, sha in fake.fetched_files}
    assert ("src/server.js", "pre-seed-head") in fetched
    assert not any(path in (".env", "yarn.lock") for path, _sha in fetched)


def test_repo_created_skips_the_code_index_without_a_model_connection(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md", "src/server.js"])

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 200, res.text
    time.sleep(0.1)
    assert client.app.state.github_client.fetched_files == []
    assert client.app.state.embed_queue.pending_for(pid) == 0


def test_reindex_backfills_code_for_a_created_repository(client: TestClient):
    pid = _imported_at_tech_review(client, ["README.md", "src/server.js"])
    ws_id = _with_model_connection(client, pid)
    client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert _wait_until(lambda: "src/server.js" in _indexed_paths(client, ws_id, pid))

    repository = client.app.state.repository
    repository.delete_code_chunks_for_path(pid, "acme/storyapp", "src/server.js")
    assert "src/server.js" not in _indexed_paths(client, ws_id, pid)

    res = client.post(f"/projects/{pid}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text
    assert _wait_until(lambda: "src/server.js" in _indexed_paths(client, ws_id, pid))


def _backfill_app():
    """Just enough of an app for `enqueue_project_backfill`: a queue and no
    event loop, so jobs are delivered inline and never drained."""
    from types import SimpleNamespace

    from app.rag.queue import EmbedQueue

    return SimpleNamespace(state=SimpleNamespace(embed_queue=EmbedQueue(), loop=None))


def _code_tree_jobs(app) -> int:
    queue = app.state.embed_queue._queue
    return sum(1 for job in list(queue._queue) if job.node_type == "code_tree")


def test_reindex_sweeps_code_only_with_a_model_connection_and_only_once(client: TestClient):
    from app.rag.backfill import enqueue_project_backfill

    pid = _imported_at_tech_review(client, ["README.md", "src/server.js"])
    repository = client.app.state.repository
    repository.update_project_repo(pid, "https://github.com/acme/storyapp", 1, "main")
    project = repository.update_project_lifecycle_status(pid, "repo_created")

    app = _backfill_app()
    enqueue_project_backfill(app, repository, project)
    assert _code_tree_jobs(app) == 0  # nothing could index it

    _with_model_connection(client, pid)
    enqueue_project_backfill(app, repository, project)
    enqueue_project_backfill(app, repository, project)
    assert _code_tree_jobs(app) == 1  # the second sweep finds one still queued
    assert app.state.embed_queue.has_pending_code_tree("acme/storyapp")


def test_a_protected_default_branch_is_its_own_refusal(client: TestClient):
    """Not `repo_moved_during_seed`: a retry cannot clear branch protection,
    so the Tech Lead is told what to change instead of being told to retry."""
    pid = _imported_at_tech_review(client, ["README.md"])
    fake: FakeGithubClient = client.app.state.github_client
    fake.protected_branches.add("acme/storyapp")

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "default_branch_protected"
    assert fake.commits == []
    assert client.get(f"/projects/{pid}", headers=ALICE).json()["lifecycle_status"] == "tech_review"


def test_a_directory_github_cannot_list_refuses_before_any_write(client: TestClient):
    """N4: the truncation walk reaches a directory whose own listing is
    truncated. There is no complete answer to "is this path free", so no
    seed — and nothing else either: no secret, no webhook, no commit."""
    pid = _imported_at_tech_review(
        client, ["README.md", "docs/guide.md"], template="github-pages"
    )
    client.app.state.settings.public_api_url = "https://api.test"
    fake: FakeGithubClient = client.app.state.github_client
    fake.tree_truncated = True
    fake.truncated_directories["acme/storyapp"] = {"docs"}

    res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "repo_tree_too_large"
    assert fake.commits == []
    assert fake.secrets == {} and fake.variables == {}
    writes = ("commit:", "secret:", "variable:", "webhook:")
    assert not any(e.startswith(writes) for e in fake.call_log)
    assert client.get(f"/projects/{pid}", headers=ALICE).json()["lifecycle_status"] == "tech_review"

    preview = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)
    assert preview.status_code == 409
    assert preview.json()["detail"] == "repo_tree_too_large"
