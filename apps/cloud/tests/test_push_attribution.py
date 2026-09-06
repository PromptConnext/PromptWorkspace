"""The cloud reads task refs off push deliveries (ADR 0023 decision 3).

It writes attribution — the Artifact row that says "this commit belongs to
this task" — and never status. Status stays with the client that observed the
publication (ADR 0022), because the server cannot tell "implemented" from
"pushed".
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import GraphUpsertRequest, RepoWebhook, Task, TaskStatus

ALICE = {"X-User-Id": "alice"}
REPO = "acme/rocket"
SECRET = "whsec_test"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        yield c


def _project(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", "main")
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project["id"],
            workspace_id=ws["id"],
            secret_ref=client.app.state.secret_store.encrypt(SECRET),
        )
    )
    repository.upsert_graph(
        project["id"],
        GraphUpsertRequest(
            tasks=[
                Task(id="t1", project_id=project["id"], title="Retry", feature_tag="T012"),
                Task(id="t2", project_id=project["id"], title="Cache", feature_tag="T2"),
            ]
        ),
        source="pz",
    )
    return project["id"]


def _push(client: TestClient, commits: list[dict], *, ref: str = "refs/heads/main"):
    payload = {
        "ref": ref,
        "after": commits[-1]["id"] if commits else "0" * 40,
        "repository": {"full_name": REPO},
        "commits": commits,
    }
    raw = json.dumps(payload).encode()
    signature = "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return client.post(
        "/api/webhooks/github",
        content=raw,
        headers={
            "X-GitHub-Event": "push",
            "X-Hub-Signature-256": signature,
            "Content-Type": "application/json",
        },
    )


def _commit(sha: str, message: str) -> dict:
    return {
        "id": sha,
        "message": message,
        "url": f"https://github.com/{REPO}/commit/{sha}",
        "added": [],
        "modified": [],
        "removed": [],
    }


def test_a_commit_subject_attributes_its_commit_to_a_task(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: add a retry T12")])
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert [(a.task_id, a.commit_sha) for a in artifacts] == [("t1", "aaa111")]


def test_attribution_never_changes_task_status(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: add a retry T12")])
    task = client.app.state.repository.get_task(project_id, "t1")
    # ADR 0022: the cloud cannot distinguish implemented from pushed.
    assert task.status == TaskStatus.todo


def test_a_replayed_delivery_writes_one_artifact(client):
    project_id = _project(client)
    for _ in range(3):
        _push(client, [_commit("aaa111", "feat: T12 retry")])
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert len(artifacts) == 1


def test_one_push_of_several_commits_attributes_each(client):
    project_id = _project(client)
    _push(
        client,
        [_commit("aaa111", "feat: T12 retry"), _commit("bbb222", "feat: T2 cache")],
    )
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert sorted((a.task_id, a.commit_sha) for a in artifacts) == [
        ("t1", "aaa111"),
        ("t2", "bbb222"),
    ]


def test_a_revert_attributes_nothing(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", 'Revert "feat: T12 retry"')])
    assert client.app.state.repository.get_graph(project_id).artifacts == []


def test_a_push_to_another_branch_is_ignored(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: T12")], ref="refs/heads/spike")
    assert client.app.state.repository.get_graph(project_id).artifacts == []


def test_a_ref_no_task_carries_is_skipped(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: T999 something else")])
    assert client.app.state.repository.get_graph(project_id).artifacts == []
