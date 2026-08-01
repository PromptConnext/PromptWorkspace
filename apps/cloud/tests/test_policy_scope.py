"""PATCH /projects/{project_id}/policy-scope (C7, Policy Scope feature)."""

from __future__ import annotations

from fastapi.testclient import TestClient

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def _bootstrap(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def test_patch_persists_and_is_visible_on_get_project(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": ["thai-pdpa", "gdpr"], "custom_text": "Extra care with QR codes."},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert res.json()["policy_scope"] == {
        "selected": ["thai-pdpa", "gdpr"],
        "custom_text": "Extra care with QR codes.",
    }

    fetched = client.get(f"/projects/{pid}", headers=ALICE).json()
    assert fetched["policy_scope"] == {
        "selected": ["thai-pdpa", "gdpr"],
        "custom_text": "Extra care with QR codes.",
    }


def test_patch_dedupes_selected_ids_preserving_first_occurrence_order(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": ["gdpr", "thai-pdpa", "gdpr"], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert res.json()["policy_scope"]["selected"] == ["gdpr", "thai-pdpa"]


def test_patch_unknown_template_id_is_422(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": ["not-a-real-template"], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "unknown_policy_template"


def test_patch_oversized_custom_text_is_422(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": [], "custom_text": "x" * 20_001},
        headers=ALICE,
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "custom_text_too_long"


def test_patch_at_exactly_the_limit_succeeds(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": [], "custom_text": "x" * 20_000},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text


def test_patch_forbidden_for_non_member(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": [], "custom_text": ""},
        headers=BOB,
    )
    assert res.status_code == 403


def test_patch_404_for_unknown_project(client: TestClient):
    res = client.patch(
        "/projects/does-not-exist/policy-scope",
        json={"selected": [], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 404


def test_patch_409_once_the_project_is_frozen(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    client.app.state.repository.update_project_lifecycle_status(pid, "repo_created")

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": ["gdpr"], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 409
    assert res.json()["detail"] == "project_frozen"


def test_patch_empty_clears_a_previously_set_scope(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": ["gdpr"], "custom_text": "keep this in mind"},
        headers=ALICE,
    )

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": [], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert res.json()["policy_scope"] == {"selected": [], "custom_text": ""}


def test_non_admin_member_can_edit_policy_scope(client: TestClient):
    """Deliberately not ADMIN_ONLY_STAGES-gated: scope is planning input any
    project member may set, not stage authoring (see app/api/_guards.py)."""
    ws_id, pid = _bootstrap(client)
    repo = client.app.state.repository
    from app.models.schemas import Role

    repo.add_member(ws_id, "bob", Role.member, invited_by="alice")

    res = client.patch(
        f"/projects/{pid}/policy-scope",
        json={"selected": ["soc-2"], "custom_text": ""},
        headers=BOB,
    )
    assert res.status_code == 200, res.text
    assert res.json()["policy_scope"]["selected"] == ["soc-2"]


def test_new_project_has_no_policy_scope_by_default(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    fetched = client.get(f"/projects/{pid}", headers=ALICE).json()
    assert fetched["policy_scope"] is None
