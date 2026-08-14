"""Tests for PATCH /projects/{id}/tasks/{id}/status (ADR 0019 / ADR 0020).

The endpoint exists so a developer client can close a task without pushing a
full graph. The regression that justifies it is
`test_status_write_preserves_title_and_acceptance_criteria` — a full-graph
"mark done" would overwrite the title (shared authority) and merge an empty
acceptance-criteria list over the cloud's (a model_dump cannot express
"unset"). Helpers mirror tests/test_task_assignment.py.
"""

from __future__ import annotations


def _ws(client, name="Acme", user="alice"):
    res = client.post("/workspaces", json={"name": name}, headers={"X-User-Id": user})
    assert res.status_code == 201, res.text
    return res.json()


def _invite_and_accept(client, workspace_id, admin_user, member_user, email=None):
    email = email or f"{member_user}@x.com"
    inv = client.post(
        f"/workspaces/{workspace_id}/invitations",
        json={"email": email},
        headers={"X-User-Id": admin_user},
    ).json()
    res = client.post(
        f"/invitations/{inv['invitation']['token']}/accept",
        headers={"X-User-Id": member_user},
    )
    assert res.status_code == 200, res.text


def _project(client, workspace_id, user="alice", name="Demo"):
    res = client.post(
        "/projects", json={"name": name, "workspace_id": workspace_id},
        headers={"X-User-Id": user},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _push_task(client, project_id, user, task_id="task-1", extra=None, source="pz"):
    task = {"id": task_id, "project_id": project_id, "title": "Build login form"}
    if extra:
        task.update(extra)
    res = client.put(
        f"/sync/projects/{project_id}/graph",
        json={"tasks": [task], "source": source},
        headers={"X-User-Id": user},
    )
    assert res.status_code == 200, res.text
    return task_id


def _graph(client, project_id, user="alice"):
    return client.get(
        f"/sync/projects/{project_id}/graph", headers={"X-User-Id": user}
    ).json()


def _get_task(client, project_id, task_id, user="alice"):
    for t in _graph(client, project_id, user)["tasks"]:
        if t["id"] == task_id:
            return t
    raise AssertionError(f"task {task_id} not found")


def _assign(client, project_id, task_id, target, user="alice"):
    res = client.patch(
        f"/projects/{project_id}/tasks/{task_id}/assignment",
        json={"assigned_user_id": target},
        headers={"X-User-Id": user},
    )
    assert res.status_code == 200, res.text


def _set_status(client, project_id, task_id, status, user="alice", artifact=None):
    body = {"status": status}
    if artifact is not None:
        body["artifact"] = artifact
    return client.patch(
        f"/projects/{project_id}/tasks/{task_id}/status",
        json=body,
        headers={"X-User-Id": user},
    )


def _setup(client, criteria=None):
    ws = _ws(client, user="alice")
    _invite_and_accept(client, ws["id"], "alice", "bob")
    _invite_and_accept(client, ws["id"], "alice", "carol")
    project = _project(client, ws["id"], user="alice")
    extra = {"acceptance_criteria": criteria} if criteria else None
    task_id = _push_task(client, project["id"], "alice", extra=extra)
    return ws, project, task_id


def test_admin_sets_status(client):
    _ws_, project, task_id = _setup(client)
    res = _set_status(client, project["id"], task_id, "in_progress")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "in_progress"
    assert body["field_versions"]["status"]["source"] == "pz"

    assert _get_task(client, project["id"], task_id)["status"] == "in_progress"


def test_assignee_sets_own_task_status(client):
    _ws_, project, task_id = _setup(client)
    _assign(client, project["id"], task_id, "bob")

    res = _set_status(client, project["id"], task_id, "implemented", user="bob")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "implemented"


def test_non_assignee_member_forbidden(client):
    _ws_, project, task_id = _setup(client)
    _assign(client, project["id"], task_id, "bob")

    res = _set_status(client, project["id"], task_id, "implemented", user="carol")
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "status_forbidden"


def test_unassigned_task_forbidden_for_member(client):
    # Deliberate: a commit mentioning a task nobody claimed must not close it.
    _ws_, project, task_id = _setup(client)
    res = _set_status(client, project["id"], task_id, "implemented", user="bob")
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "status_forbidden"


def test_member_can_self_assign_then_close(client):
    # The client-side answer to the rule above: members may already self-assign.
    _ws_, project, task_id = _setup(client)
    _assign(client, project["id"], task_id, "bob", user="bob")

    res = _set_status(client, project["id"], task_id, "implemented", user="bob")
    assert res.status_code == 200, res.text


def test_verified_requires_admin(client):
    _ws_, project, task_id = _setup(client)
    _assign(client, project["id"], task_id, "bob")

    res = _set_status(client, project["id"], task_id, "verified", user="bob")
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "verified_requires_admin"

    res = _set_status(client, project["id"], task_id, "verified", user="alice")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "verified"


def test_invalid_status_rejected(client):
    _ws_, project, task_id = _setup(client)
    res = _set_status(client, project["id"], task_id, "done")
    assert res.status_code == 422, res.text


def test_missing_task_404(client):
    _ws_, project, _task_id = _setup(client)
    res = _set_status(client, project["id"], "nope", "implemented")
    assert res.status_code == 404, res.text
    assert res.json()["detail"] == "task_not_found"


def test_non_member_cannot_reach_the_task(client):
    _ws_, project, task_id = _setup(client)
    res = _set_status(client, project["id"], task_id, "implemented", user="mallory")
    assert res.status_code in (403, 404), res.text


def test_status_write_preserves_title_and_acceptance_criteria(client):
    # The regression this endpoint exists for (ADR 0020): the full-graph PUT
    # would clobber both.
    criteria = [{"text": "Rejects a bad password"}, {"text": "Locks after 5 tries"}]
    _ws_, project, task_id = _setup(client, criteria=criteria)

    res = _set_status(client, project["id"], task_id, "implemented")
    assert res.status_code == 200, res.text

    pulled = _get_task(client, project["id"], task_id)
    assert pulled["title"] == "Build login form"
    assert [c["text"] for c in pulled["acceptance_criteria"]] == [
        "Rejects a bad password",
        "Locks after 5 tries",
    ]


def test_status_patch_attaches_artifact(client):
    _ws_, project, task_id = _setup(client)
    sha = "a" * 40
    res = _set_status(
        client, project["id"], task_id, "implemented",
        artifact={"commit_sha": sha, "uri": "git: T1: add retry", "kind": "code"},
    )
    assert res.status_code == 200, res.text

    artifacts = _graph(client, project["id"])["artifacts"]
    mine = [a for a in artifacts if a["task_id"] == task_id]
    assert len(mine) == 1
    assert mine[0]["commit_sha"] == sha
    assert mine[0]["uri"] == "git: T1: add retry"
    assert mine[0]["kind"] == "code"


def test_artifact_attach_is_idempotent(client):
    # A client replays commits whenever its cache is dropped or a repo is
    # re-cloned, so this is the expected path, not the exceptional one.
    _ws_, project, task_id = _setup(client)
    sha = "b" * 40
    artifact = {"commit_sha": sha, "uri": "git: T1: add retry", "kind": "code"}
    for _ in range(3):
        assert _set_status(
            client, project["id"], task_id, "implemented", artifact=artifact
        ).status_code == 200

    artifacts = _graph(client, project["id"])["artifacts"]
    assert len([a for a in artifacts if a["commit_sha"] == sha]) == 1


def test_distinct_commits_produce_distinct_artifacts(client):
    _ws_, project, task_id = _setup(client)
    for sha in ("c" * 40, "d" * 40):
        assert _set_status(
            client, project["id"], task_id, "implemented",
            artifact={"commit_sha": sha, "uri": f"git: {sha[:7]}", "kind": "code"},
        ).status_code == 200

    artifacts = _graph(client, project["id"])["artifacts"]
    assert len([a for a in artifacts if a["task_id"] == task_id]) == 2


def test_status_patch_does_not_clobber_assignment(client):
    _ws_, project, task_id = _setup(client)
    _assign(client, project["id"], task_id, "bob")

    res = _set_status(client, project["id"], task_id, "implemented", user="bob")
    assert res.status_code == 200, res.text
    assert res.json()["assigned_user_id"] == "bob"
    assert _get_task(client, project["id"], task_id)["assigned_user_id"] == "bob"
