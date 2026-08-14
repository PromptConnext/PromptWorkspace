"""Tests for GET /me/tasks (ADR 0019 / ADR 0020).

The read a task client opens with: every task assigned to the caller, across
every workspace they belong to, with the project and repo context needed to
match it against a local clone.
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


def _push_task(client, project_id, user, task_id, title="Build login form", extra=None):
    task = {"id": task_id, "project_id": project_id, "title": title}
    if extra:
        task.update(extra)
    res = client.put(
        f"/sync/projects/{project_id}/graph",
        json={"tasks": [task], "source": "pz"},
        headers={"X-User-Id": user},
    )
    assert res.status_code == 200, res.text
    return task_id


def _assign(client, project_id, task_id, target, user="alice"):
    res = client.patch(
        f"/projects/{project_id}/tasks/{task_id}/assignment",
        json={"assigned_user_id": target},
        headers={"X-User-Id": user},
    )
    assert res.status_code == 200, res.text


def _my_tasks(client, user="bob", **params):
    res = client.get("/me/tasks", params=params, headers={"X-User-Id": user})
    assert res.status_code == 200, res.text
    return res.json()


def _two_workspaces(client):
    """bob is a member of two workspaces and holds one task in each."""
    ws_a = _ws(client, name="Acme", user="alice")
    ws_b = _ws(client, name="Beta", user="alice")
    _invite_and_accept(client, ws_a["id"], "alice", "bob")
    _invite_and_accept(client, ws_b["id"], "alice", "bob", email="bob2@x.com")
    proj_a = _project(client, ws_a["id"], name="Alpha")
    proj_b = _project(client, ws_b["id"], name="Bravo")
    _push_task(client, proj_a["id"], "alice", "t-a", extra={"feature_tag": "T001"})
    _push_task(client, proj_b["id"], "alice", "t-b", extra={"feature_tag": "T002"})
    _assign(client, proj_a["id"], "t-a", "bob")
    _assign(client, proj_b["id"], "t-b", "bob")
    return ws_a, ws_b, proj_a, proj_b


def test_lists_tasks_assigned_to_caller_across_workspaces(client):
    ws_a, ws_b, proj_a, proj_b = _two_workspaces(client)
    rows = _my_tasks(client)
    assert [r["task"]["id"] for r in rows] == ["t-a", "t-b"]  # sorted by project name
    assert {r["workspace_id"] for r in rows} == {ws_a["id"], ws_b["id"]}


def test_excludes_other_users_tasks(client):
    ws = _ws(client)
    _invite_and_accept(client, ws["id"], "alice", "bob")
    _invite_and_accept(client, ws["id"], "alice", "carol")
    project = _project(client, ws["id"])
    _push_task(client, project["id"], "alice", "mine")
    _push_task(client, project["id"], "alice", "theirs")
    _assign(client, project["id"], "mine", "bob")
    _assign(client, project["id"], "theirs", "carol")

    assert [r["task"]["id"] for r in _my_tasks(client)] == ["mine"]


def test_unassigned_tasks_are_not_listed(client):
    ws = _ws(client)
    _invite_and_accept(client, ws["id"], "alice", "bob")
    project = _project(client, ws["id"])
    _push_task(client, project["id"], "alice", "loose")

    assert _my_tasks(client) == []


def test_defaults_to_open_statuses(client):
    _ws_a, _ws_b, proj_a, _proj_b = _two_workspaces(client)
    res = client.patch(
        f"/projects/{proj_a['id']}/tasks/t-a/status",
        json={"status": "implemented"},
        headers={"X-User-Id": "bob"},
    )
    assert res.status_code == 200, res.text

    assert [r["task"]["id"] for r in _my_tasks(client)] == ["t-b"]


def test_status_filter(client):
    _two_workspaces(client)
    rows = _my_tasks(client, status="todo")
    assert len(rows) == 2
    assert _my_tasks(client, status="verified") == []


def test_workspace_filter(client):
    ws_a, _ws_b, _proj_a, _proj_b = _two_workspaces(client)
    rows = _my_tasks(client, workspace_id=ws_a["id"])
    assert [r["task"]["id"] for r in rows] == ["t-a"]


def test_excludes_tasks_in_workspaces_the_caller_left(client):
    # An assignment outlives a membership removal — the read must not.
    ws_a, _ws_b, _proj_a, _proj_b = _two_workspaces(client)
    res = client.delete(
        f"/workspaces/{ws_a['id']}/members/bob", headers={"X-User-Id": "alice"}
    )
    assert res.status_code in (200, 204), res.text

    assert [r["task"]["id"] for r in _my_tasks(client)] == ["t-b"]


def test_includes_project_and_workspace_context(client):
    ws = _ws(client)
    _invite_and_accept(client, ws["id"], "alice", "bob")
    project = _project(client, ws["id"], name="Alpha")
    _push_task(client, project["id"], "alice", "t-1", extra={
        "feature_tag": "T001",
        "acceptance_criteria": [{"text": "Rejects a bad password"}],
    })
    _assign(client, project["id"], "t-1", "bob")

    row = _my_tasks(client)[0]
    assert row["project_id"] == project["id"]
    assert row["project_name"] == "Alpha"
    assert row["workspace_id"] == ws["id"]
    assert row["workspace_name"] == "Acme"
    assert row["repo_url"] is None  # no repo until tech-review exit (ADR 0017)
    assert row["task"]["feature_tag"] == "T001"
    assert [c["text"] for c in row["task"]["acceptance_criteria"]] == [
        "Rejects a bad password"
    ]


def test_limit_caps_results(client):
    ws = _ws(client)
    _invite_and_accept(client, ws["id"], "alice", "bob")
    project = _project(client, ws["id"])
    for i in range(3):
        _push_task(client, project["id"], "alice", f"t-{i}", extra={"feature_tag": f"T00{i}"})
        _assign(client, project["id"], f"t-{i}", "bob")

    assert len(_my_tasks(client, limit=2)) == 2
    assert len(_my_tasks(client)) == 3


def test_limit_bounds_enforced(client):
    _two_workspaces(client)
    headers = {"X-User-Id": "bob"}
    assert client.get("/me/tasks", params={"limit": 0}, headers=headers).status_code == 422
    assert client.get("/me/tasks", params={"limit": 5000}, headers=headers).status_code == 422


def test_stranger_sees_nothing(client):
    _two_workspaces(client)
    assert _my_tasks(client, user="mallory") == []
