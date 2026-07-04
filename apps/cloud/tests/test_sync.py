"""End-to-end tests for the Sync API against the in-memory backend."""


def _create_project(client, name="Demo", user="alice"):
    res = client.post("/projects", json={"name": name}, headers={"X-User-Id": user})
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
