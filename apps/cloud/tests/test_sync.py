"""End-to-end tests for the Sync API against the in-memory backend."""

from datetime import timedelta

from app.models.schemas import utcnow


def _create_workspace(client, name="WS", user="alice"):
    res = client.post("/workspaces", json={"name": name}, headers={"X-User-Id": user})
    assert res.status_code == 201, res.text
    return res.json()


def _create_project(client, name="Demo", user="alice", workspace_id=None):
    if workspace_id is None:
        workspace_id = _create_workspace(client, user=user)["id"]
    res = client.post(
        "/projects",
        json={"name": name, "workspace_id": workspace_id},
        headers={"X-User-Id": user},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_create_and_get_project(client):
    project = _create_project(client)
    assert project["name"] == "Demo"
    assert project["owner_id"] == "alice"
    assert project["stage_state"]["scope"] == "active"

    got = client.get(f"/projects/{project['id']}", headers={"X-User-Id": "alice"})
    assert got.status_code == 200
    assert got.json()["id"] == project["id"]


def test_get_missing_project_404(client):
    res = client.get("/projects/does-not-exist", headers={"X-User-Id": "alice"})
    assert res.status_code == 404


def test_owner_isolation(client):
    project = _create_project(client, user="alice")
    # Another user may not read it (owner-only until real auth/sharing).
    res = client.get(f"/projects/{project['id']}", headers={"X-User-Id": "bob"})
    assert res.status_code == 403

    # And listing is per-user.
    assert client.get("/projects", headers={"X-User-Id": "bob"}).json() == []
    assert len(client.get("/projects", headers={"X-User-Id": "alice"}).json()) == 1


def test_push_and_pull_graph(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    payload = {
        "requirements": [
            {"id": "req-1", "project_id": pid, "title": "User can log in"}
        ],
        "tasks": [
            {
                "id": "task-1",
                "project_id": pid,
                "title": "Build login form",
                "acceptance_criteria": [{"text": "Email + password fields"}],
            }
        ],
    }
    res = client.put(f"/sync/projects/{pid}/graph", json=payload, headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["upserted"] == {"requirements": 1, "tasks": 1}
    assert body["cursor"] is not None

    pulled = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()
    assert len(pulled["requirements"]) == 1
    assert pulled["requirements"][0]["title"] == "User can log in"
    assert pulled["tasks"][0]["acceptance_criteria"][0]["text"] == "Email + password fields"
    # Server stamps updated_at even though the client didn't send it.
    assert pulled["tasks"][0]["updated_at"] is not None


def test_incremental_pull_with_since(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "First"}]},
        headers=headers,
    )
    cursor = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()["cursor"]

    # Nothing new since the cursor.
    empty = client.get(
        f"/sync/projects/{pid}/graph", params={"since": cursor}, headers=headers
    ).json()
    assert empty["requirements"] == []

    # Add another entity, then an incremental pull returns only the new one.
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r2", "project_id": pid, "title": "Second"}]},
        headers=headers,
    )
    delta = client.get(
        f"/sync/projects/{pid}/graph", params={"since": cursor}, headers=headers
    ).json()
    titles = [r["title"] for r in delta["requirements"]]
    assert titles == ["Second"]


def test_upsert_updates_existing_entity(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    client.put(
        f"/sync/projects/{pid}/graph",
        json={"tasks": [{"id": "t1", "project_id": pid, "title": "Old", "status": "todo"}]},
        headers=headers,
    )
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"tasks": [{"id": "t1", "project_id": pid, "title": "New", "status": "implemented"}]},
        headers=headers,
    )
    tasks = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["title"] == "New"
    assert tasks[0]["status"] == "implemented"


# --------------------------------------------------------------------------- #
# Milestone 3 — per-field conflict ownership (end-to-end through the API)
# --------------------------------------------------------------------------- #
def test_pmo_source_cannot_change_pz_fields_but_owns_pmo_fields(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    # PromptZone (default source="pz") sets an agent-driven status.
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"tasks": [{"id": "t1", "project_id": pid, "title": "X", "status": "in_progress"}]},
        headers=headers,
    )
    # An external tracker (source="pmo") tries to overwrite status (a pz field)
    # and set assignee (a pmo field) in the same push.
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "source": "pmo",
            "tasks": [
                {
                    "id": "t1",
                    "project_id": pid,
                    "title": "X",
                    "status": "verified",
                    "assignee": "alice",
                }
            ],
        },
        headers=headers,
    )
    task = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()["tasks"][0]
    assert task["status"] == "in_progress"  # pz field untouched by pmo
    assert task["assignee"] == "alice"  # pmo owns assignee


# --------------------------------------------------------------------------- #
# Milestone 1 — tombstone soft-delete
# --------------------------------------------------------------------------- #
def test_delete_propagates_via_incremental_pull(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "First"}]},
        headers=headers,
    )
    cursor = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()["cursor"]

    # Delete = upsert the same id with deleted_at set.
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "First",
                    "deleted_at": utcnow().isoformat(),
                }
            ]
        },
        headers=headers,
    )

    delta = client.get(
        f"/sync/projects/{pid}/graph", params={"since": cursor}, headers=headers
    ).json()
    assert len(delta["requirements"]) == 1
    assert delta["requirements"][0]["id"] == "r1"
    assert delta["requirements"][0]["deleted_at"] is not None


def test_bootstrap_pull_hides_deleted(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "First"}]},
        headers=headers,
    )
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "First",
                    "deleted_at": utcnow().isoformat(),
                }
            ]
        },
        headers=headers,
    )

    # A fresh (since-less) pull never sees the tombstoned row.
    bootstrap = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()
    assert bootstrap["requirements"] == []


def test_recreate_after_delete(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "First"}]},
        headers=headers,
    )
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "First",
                    "deleted_at": utcnow().isoformat(),
                }
            ]
        },
        headers=headers,
    )
    # Re-upsert without deleted_at restores it as live.
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "First (restored)"}]},
        headers=headers,
    )

    bootstrap = client.get(f"/sync/projects/{pid}/graph", headers=headers).json()
    assert len(bootstrap["requirements"]) == 1
    assert bootstrap["requirements"][0]["deleted_at"] is None
    assert bootstrap["requirements"][0]["title"] == "First (restored)"


def test_tombstone_gc_purges_old_deleted_rows(client):
    project = _create_project(client)
    pid = project["id"]
    headers = {"X-User-Id": "alice"}

    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [{"id": "r1", "project_id": pid, "title": "First"}],
            "tasks": [{"id": "t1", "project_id": pid, "title": "Old task"}],
        },
        headers=headers,
    )
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "First",
                    "deleted_at": utcnow().isoformat(),
                }
            ],
            "tasks": [
                {
                    "id": "t1",
                    "project_id": pid,
                    "title": "Old task",
                    "deleted_at": (utcnow() - timedelta(days=1)).isoformat(),
                }
            ],
        },
        headers=headers,
    )

    repo = client.app.state.repository
    # Force the requirement's tombstone to look old enough to purge; leave
    # the task's tombstone fresh so it's untouched by a 30-day TTL.
    project_store = repo._graph[pid]  # test-only reach into InMemoryRepository internals
    project_store["requirements"]["r1"].deleted_at = utcnow() - timedelta(days=31)

    purged = repo.purge_expired_tombstones(ttl_days=30)
    assert purged.get("requirements") == 1
    assert "tasks" not in purged  # task tombstone is only 1 day old

    # Purge never touches live rows: task-graph fetch (since-less) already
    # hid the tombstone; incremental pull confirms the row is truly gone.
    assert "r1" not in project_store["requirements"]
    assert "t1" in project_store["tasks"]
