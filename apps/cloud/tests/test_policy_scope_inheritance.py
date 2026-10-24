"""Projects inherit the workspace policy scope (plan 0033)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.delivery.receipts import verify_chain
from app.main import create_app
from app.models.schemas import Receipt

ALICE = {"X-User-Id": "alice"}  # creator, admin
BOB = {"X-User-Id": "bob"}  # member


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def workspace(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    inv = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    token = inv["invitation"]["token"]
    assert client.post(f"/invitations/{token}/accept", headers=BOB).status_code == 200
    return ws["id"]


def _put_gov(
    client: TestClient,
    ws: str,
    selected: list[str],
    text: str = "",
    hats: list[str] | None = None,
) -> None:
    res = client.put(
        f"/workspaces/{ws}/governance",
        json={
            "policy_scope": {"selected": selected, "custom_text": text},
            "required_hats": hats or ["tech_steward"],
            "require_seeded_rules": False,
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text


def _project(client: TestClient, ws: str, name: str = "P") -> dict:
    res = client.post("/projects", json={"workspace_id": ws, "name": name}, headers=ALICE)
    assert res.status_code == 201, res.text
    return res.json()


def _policy_receipts(client: TestClient, pid: str) -> list[dict]:
    res = client.get(f"/projects/{pid}/receipts", headers=ALICE)
    assert res.status_code == 200, res.text
    data = res.json()
    items = data["receipts"] if isinstance(data, dict) else data
    return [r for r in items if r["event"] == "policy_scope.updated"]


def test_new_project_copies_workspace_scope_with_source_workspace(
    client: TestClient, workspace: str
) -> None:
    _put_gov(client, workspace, ["gdpr"], "tidy")
    p = _project(client, workspace)
    assert p["policy_scope_source"] == "workspace"
    assert p["policy_scope"]["selected"] == ["gdpr"]
    assert p["policy_scope"]["custom_text"] == "tidy"


def test_new_project_with_empty_workspace_scope_still_inherits(
    client: TestClient, workspace: str
) -> None:
    p = _project(client, workspace)
    assert p["policy_scope_source"] == "workspace"


def test_project_patch_sets_source_project(client: TestClient, workspace: str) -> None:
    p = _project(client, workspace)
    res = client.patch(
        f"/projects/{p['id']}/policy-scope",
        json={"selected": ["gdpr"], "custom_text": ""},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert res.json()["policy_scope_source"] == "project"


def test_put_governance_rewrites_only_inheriting_unfrozen_projects(
    client: TestClient, workspace: str
) -> None:
    inheriting = _project(client, workspace, "inherit")
    own = _project(client, workspace, "own")
    frozen = _project(client, workspace, "frozen")
    client.patch(
        f"/projects/{own['id']}/policy-scope",
        json={"selected": ["gdpr"], "custom_text": ""},
        headers=ALICE,
    )
    # The memory adapter returns stored instances: freeze by mutating in place.
    client.app.state.repository.get_project(frozen["id"]).lifecycle_status = "repo_created"

    _put_gov(client, workspace, ["gdpr", "soc-2"])

    got = client.get(f"/projects/{inheriting['id']}", headers=ALICE).json()
    assert got["policy_scope"]["selected"] == ["gdpr", "soc-2"]
    assert got["policy_scope_source"] == "workspace"
    receipts = _policy_receipts(client, inheriting["id"])
    assert len(receipts) == 1
    assert receipts[0]["subject_type"] == "project_policy"
    assert receipts[0]["subject_id"] == inheriting["id"]
    assert receipts[0]["body"] == {
        "source": "workspace",
        "before": "",
        "after": "gdpr,soc-2",
        "custom_text_changed": "false",
    }

    own_got = client.get(f"/projects/{own['id']}", headers=ALICE).json()
    assert own_got["policy_scope"]["selected"] == ["gdpr"]
    assert own_got["policy_scope_source"] == "project"
    assert _policy_receipts(client, own["id"]) == []

    frozen_got = client.get(f"/projects/{frozen['id']}", headers=ALICE).json()
    assert frozen_got["policy_scope"]["selected"] == []
    assert _policy_receipts(client, frozen["id"]) == []


def test_use_workspace_copies_and_sets_source(client: TestClient, workspace: str) -> None:
    p = _project(client, workspace)
    client.patch(
        f"/projects/{p['id']}/policy-scope",
        json={"selected": ["soc-2"], "custom_text": ""},
        headers=ALICE,
    )
    _put_gov(client, workspace, ["gdpr"])
    res = client.post(f"/projects/{p['id']}/policy-scope/use-workspace", headers=BOB)
    assert res.status_code == 200, res.text
    assert res.json()["policy_scope"]["selected"] == ["gdpr"]
    assert res.json()["policy_scope_source"] == "workspace"


def test_use_workspace_refused_when_frozen(client: TestClient, workspace: str) -> None:
    p = _project(client, workspace)
    # The memory adapter returns stored instances: freeze by mutating in place.
    client.app.state.repository.get_project(p["id"]).lifecycle_status = "repo_created"
    res = client.post(f"/projects/{p['id']}/policy-scope/use-workspace", headers=ALICE)
    assert res.status_code == 409
    assert res.json()["detail"] == "project_frozen"


def test_receipt_chain_still_verifies_after_policy_receipt(
    client: TestClient, workspace: str
) -> None:
    p = _project(client, workspace)
    _put_gov(client, workspace, ["gdpr"])
    chain = client.app.state.repository.list_receipts(p["id"])
    assert any(r.event == "policy_scope.updated" for r in chain)
    assert isinstance(chain[0], Receipt)
    assert verify_chain(chain).ok


def test_put_governance_with_same_scope_writes_no_project_or_receipt(
    client: TestClient, workspace: str
) -> None:
    _put_gov(client, workspace, ["gdpr"], "tidy")
    p = _project(client, workspace)
    repo = client.app.state.repository
    before_updated = repo.get_project(p["id"]).updated_at
    before_chain = len(repo.list_receipts(p["id"]))

    _put_gov(client, workspace, ["gdpr"], "tidy", hats=["business_owner", "tech_steward"])

    assert _policy_receipts(client, p["id"]) == []
    assert len(repo.list_receipts(p["id"])) == before_chain
    assert repo.get_project(p["id"]).updated_at == before_updated


def test_put_governance_custom_text_only_change_writes_receipt_with_flag(
    client: TestClient, workspace: str
) -> None:
    _put_gov(client, workspace, ["gdpr"], "tidy")
    p = _project(client, workspace)
    _put_gov(client, workspace, ["gdpr"], "tidier")
    receipts = _policy_receipts(client, p["id"])
    assert len(receipts) == 1
    assert receipts[0]["body"] == {
        "source": "workspace",
        "before": "gdpr",
        "after": "gdpr",
        "custom_text_changed": "true",
    }
