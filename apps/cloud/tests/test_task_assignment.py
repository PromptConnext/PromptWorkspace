"""Tests for PATCH /projects/{id}/tasks/{id}/assignment (ADR 0018 / M1)."""

from __future__ import annotations

from app.models.schemas import GraphUpsertRequest, Task


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


def _get_task(client, project_id, task_id, user="alice"):
    graph = client.get(
        f"/sync/projects/{project_id}/graph", headers={"X-User-Id": user}
    ).json()
    for t in graph["tasks"]:
        if t["id"] == task_id:
            return t
    raise AssertionError(f"task {task_id} not found")


def _setup(client):
    ws = _ws(client, user="alice")
    _invite_and_accept(client, ws["id"], "alice", "bob")
    _invite_and_accept(client, ws["id"], "alice", "carol")
    project = _project(client, ws["id"], user="alice")
    task_id = _push_task(client, project["id"], "alice")
    return ws, project, task_id


def test_admin_assigns_member(client):
    ws, project, task_id = _setup(client)
    res = client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["assigned_user_id"] == "bob"
    assert body["field_versions"]["assigned_user_id"]["source"] == "pz"

    pulled = _get_task(client, project["id"], task_id)
    assert pulled["assigned_user_id"] == "bob"


def test_member_self_assigns(client):
    ws, project, task_id = _setup(client)
    res = client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "bob"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["assigned_user_id"] == "bob"


def test_member_cannot_assign_third_party(client):
    ws, project, task_id = _setup(client)
    res = client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "carol"},
        headers={"X-User-Id": "bob"},
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "assignment_forbidden"


def test_member_unassigns_own_task_but_not_others(client):
    ws, project, task_id = _setup(client)
    client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )
    # bob unassigns his own task
    res = client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": None},
        headers={"X-User-Id": "bob"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["assigned_user_id"] is None

    # reassign to bob, carol tries to unassign it - forbidden
    client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )
    res = client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": None},
        headers={"X-User-Id": "carol"},
    )
    assert res.status_code == 403


def test_assign_non_member_rejected(client):
    ws, project, task_id = _setup(client)
    res = client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "dave"},
        headers={"X-User-Id": "alice"},
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "assignee_not_a_member"


def test_assign_missing_task_404(client):
    ws, project, _task_id = _setup(client)
    res = client.patch(
        f"/projects/{project['id']}/tasks/does-not-exist/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )
    assert res.status_code == 404


def test_pmo_assignee_and_pz_assigned_user_id_coexist(client):
    ws, project, task_id = _setup(client)
    # The pmo tracker mirror sets the free-text assignee. It writes in-process,
    # through the repository, exactly as the signature-verified webhook does
    # (app/api/integrations.py) — the HTTP push can no longer *declare* itself a
    # pmo writer (plan 0015 M2), so mirroring through it would prove nothing.
    client.app.state.repository.upsert_graph(
        project["id"],
        GraphUpsertRequest(
            tasks=[
                Task(
                    id=task_id,
                    project_id=project["id"],
                    title="Build login form",
                    assignee="Jira Name",
                )
            ]
        ),
        source="pmo",
    )
    client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )
    pulled = _get_task(client, project["id"], task_id)
    assert pulled["assignee"] == "Jira Name"
    assert pulled["assigned_user_id"] == "bob"


def test_engine_push_does_not_clobber_assignment(client):
    ws, project, task_id = _setup(client)
    client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )
    # A normal pz engine-style push omits assigned_user_id entirely.
    _push_task(client, project["id"], "alice", task_id=task_id, extra={"status": "in_progress"})
    pulled = _get_task(client, project["id"], task_id)
    assert pulled["assigned_user_id"] == "bob"
    assert pulled["status"] == "in_progress"


# --------------------------------------------------------------------------- #
# The same rule at the other door (plan 0015 M4)
# --------------------------------------------------------------------------- #
# `assigned_user_id` is writable through `PUT /sync/projects/{id}/graph` as
# well, so the rule above is only real if the full-graph push refuses what this
# route refuses, with the same detail string.
def _push_assignment(client, project_id, task_id, target, user, source=None):
    task = {
        "id": task_id,
        "project_id": project_id,
        "title": "Build login form",
        "assigned_user_id": target,
    }
    body = {"tasks": [task]}
    if source is not None:
        body["source"] = source
    return client.put(
        f"/sync/projects/{project_id}/graph", json=body, headers={"X-User-Id": user}
    )


def test_graph_push_cannot_assign_a_third_party(client):
    ws, project, task_id = _setup(client)

    res = _push_assignment(client, project["id"], task_id, "carol", user="bob")
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "assignment_forbidden"  # identical to the PATCH
    assert _get_task(client, project["id"], task_id)["assigned_user_id"] is None


def test_graph_push_declaring_source_pmo_cannot_assign_a_third_party(client):
    """Declaring "pmo" in the body used to change which fields the merge let
    through; it no longer picks the writer's authority at all (plan 0015 M2)."""
    ws, project, task_id = _setup(client)

    res = _push_assignment(client, project["id"], task_id, "carol", user="bob", source="pmo")
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "assignment_forbidden"


def test_graph_push_cannot_steal_someone_elses_task(client):
    ws, project, task_id = _setup(client)
    client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )

    # carol reassigning bob's task to herself is a self-assign the dedicated
    # route allows, so the interesting theft is unassigning it.
    res = _push_assignment(client, project["id"], task_id, None, user="carol")
    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "assignment_forbidden"
    assert _get_task(client, project["id"], task_id)["assigned_user_id"] == "bob"


def test_graph_push_may_still_self_assign(client):
    ws, project, task_id = _setup(client)

    res = _push_assignment(client, project["id"], task_id, "bob", user="bob")
    assert res.status_code == 200, res.text
    assert _get_task(client, project["id"], task_id)["assigned_user_id"] == "bob"


def test_graph_push_that_omits_assigned_user_id_is_not_an_assignment(client):
    """The field is dropped from a push that never mentions it (merge.py's
    _OMIT_IF_UNSET), so a member's ordinary snapshot push must not be read as
    "unassign everyone" and refused."""
    ws, project, task_id = _setup(client)
    client.patch(
        f"/projects/{project['id']}/tasks/{task_id}/assignment",
        json={"assigned_user_id": "bob"},
        headers={"X-User-Id": "alice"},
    )

    res = _push_task(client, project["id"], "carol", task_id=task_id)
    assert res == task_id
    assert _get_task(client, project["id"], task_id)["assigned_user_id"] == "bob"
