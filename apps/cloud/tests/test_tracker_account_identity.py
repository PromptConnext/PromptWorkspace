"""Plan 0019 M5 — a tracker reference belongs to an account, not to a provider.

The defect these cases pin (finding 16 of docs/cloud-codebase-review-2026-09-06
.md): `pz_task_links` was keyed `(provider, external_key)` and the inbound
webhook route resolved a delivery on exactly that pair. A Jira issue key is
unique within a *site*, so two workspaces that each connect their own Atlassian
tenant and each run a project keyed `PZ` both address `('jira', 'PZ-1')` —
whichever mirrored first owned the row, and either site's delivery then updated
that one task. Nothing caught it: the only credential in the path was one
process-wide `JIRA_WEBHOOK_SECRET` that every configured site held, so both
sites' signatures verified.

`tests/test_sync.py::test_owner_isolation` is the isolation test the suite had,
and it establishes something adjacent but different — that *bob* cannot read
*alice*'s project through the authenticated API. It says nothing about two
trackers addressing one link row through an unauthenticated, signature-only
webhook, which is a path with no per-caller identity to isolate on until this
plan gave it one.

Every case below stands up two real Jira sites through the real routes and
drives the real webhook endpoint, following the fixture and stub shape of
`tests/test_jira_comments.py`.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from tests._tracker import account_secret

SITE_A = "https://site-a.atlassian.net"
SITE_B = "https://site-b.atlassian.net"
# Both sites run a project keyed PZ, which is the whole point: the issue key
# each produces is identical.
PROJECT_KEY = "PZ"
ISSUE_KEY = "PZ-1"

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def jira_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("JIRA_EMAIL", "bot@acme.com")
    monkeypatch.setenv("JIRA_API_TOKEN", "token-123")
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


class _CountingSend:
    """Stands in for `app.api.integrations._send`, counting outbound creates.

    The "no second create request" half of the repeat-mirror assertion is not
    observable from the response alone — a duplicate issue looks like a
    successful mirror — so the transport has to be the witness.
    """

    def __init__(self, key: str = ISSUE_KEY) -> None:
        self.key = key
        self.calls: list[str] = []

    def __call__(self, outbound, auth) -> dict:
        self.calls.append(outbound.url)
        return {"key": self.key}


def _site(
    client: TestClient, monkeypatch, user: dict, base_url: str, task_id: str = "t1"
) -> tuple[str, str]:
    """One workspace bound to one Jira site, with one task mirrored to `PZ-1`.

    `task_id` is a parameter because task ids are globally unique in this schema
    (`CrossProjectWrite`), so the two sites cannot both call their task `t1`.
    Returns (workspace_id, project_id)."""
    ws = client.post("/workspaces", json={"name": base_url}, headers=user).json()
    pid = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=user
    ).json()["id"]
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "tasks": [
                {
                    "id": task_id,
                    "project_id": pid,
                    "title": "Login",
                    "status": "in_progress",
                }
            ]
        },
        headers=user,
    )
    cfg = client.post(
        f"/workspaces/{ws['id']}/integrations/jira",
        json={"base_url": base_url, "project_key": PROJECT_KEY},
        headers=user,
    )
    assert cfg.status_code == 200, cfg.text

    import app.api.integrations as integ

    monkeypatch.setattr(integ, "_send", _CountingSend())
    link = client.post(
        f"/projects/{pid}/tasks/{task_id}/mirror", params={"provider": "jira"}, headers=user
    )
    assert link.status_code == 200, link.text
    assert link.json()["external_key"] == ISSUE_KEY
    assert link.json()["account_key"] == base_url
    return ws["id"], pid


def _two_sites(client: TestClient, monkeypatch):
    """Two workspaces, two Jira sites, one identical issue key.

    Owned by two different users so a leak would also be a cross-tenant leak,
    not merely a cross-project one.
    """
    ws_a, pid_a = _site(client, monkeypatch, ALICE, SITE_A, task_id="task-a")
    ws_b, pid_b = _site(client, monkeypatch, BOB, SITE_B, task_id="task-b")
    assert pid_a != pid_b
    # Distinct rows under the new three-column key, not one shared row.
    links = client.app.state.repository._task_links
    assert len(links) == 2, links
    return (ws_a, pid_a), (ws_b, pid_b)


def _deliver(client: TestClient, signing_workspace_id: str, payload: dict, site: str):
    """POST a webhook as `site`, signed with `signing_workspace_id`'s secret.

    The two are separable on purpose: a case can claim to be site A while
    holding only site B's secret, which is the forgery the per-account secret
    has to refuse.
    """
    payload = {
        **payload,
        "issue": {**payload["issue"], "self": f"{site}/rest/api/3/issue/10001"},
    }
    raw = json.dumps(payload).encode()
    secret = account_secret(client, signing_workspace_id)
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post(
        "/api/webhooks/jira",
        content=raw,
        headers={"X-Hub-Signature-256": f"sha256={sig}", "Content-Type": "application/json"},
    )


def _assignee(client: TestClient, pid: str, user: dict) -> str | None:
    graph = client.get(f"/sync/projects/{pid}/graph", headers=user).json()
    return graph["tasks"][0]["assignee"]


def _issue_updated(assignee: str) -> dict:
    return {
        "webhookEvent": "jira:issue_updated",
        "issue": {"key": ISSUE_KEY, "fields": {"assignee": {"displayName": assignee}}},
    }


# --------------------------------------------------------------------------- #
# 1. Two sites, identical issue keys, no cross-project update
# --------------------------------------------------------------------------- #
def test_identical_issue_keys_on_two_sites_do_not_cross_update(jira_client, monkeypatch):
    (ws_a, pid_a), (ws_b, pid_b) = _two_sites(jira_client, monkeypatch)

    # Site A's own delivery for its own PZ-1.
    res = _deliver(jira_client, ws_a, _issue_updated("From site A"), SITE_A)
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 1
    assert _assignee(jira_client, pid_a, ALICE) == "From site A"
    assert _assignee(jira_client, pid_b, BOB) is None  # untouched

    # And the reverse: site B's delivery lands only on B.
    res = _deliver(jira_client, ws_b, _issue_updated("From site B"), SITE_B)
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 1
    assert _assignee(jira_client, pid_b, BOB) == "From site B"
    assert _assignee(jira_client, pid_a, ALICE) == "From site A"  # still A's value


def test_site_a_secret_cannot_sign_for_site_b(jira_client, monkeypatch):
    """The old failure mode, stated directly.

    Under a shared `JIRA_WEBHOOK_SECRET` this delivery verified — one secret,
    every site — and then resolved `('jira', 'PZ-1')` to whichever workspace
    mirrored first. Now the payload claims site B while holding site A's secret,
    and the signature is checked against *B's* key, so it fails.
    """
    (ws_a, pid_a), (_ws_b, pid_b) = _two_sites(jira_client, monkeypatch)
    res = _deliver(jira_client, ws_a, _issue_updated("Forged"), SITE_B)
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_signature"
    assert _assignee(jira_client, pid_a, ALICE) is None
    assert _assignee(jira_client, pid_b, BOB) is None


def test_unconfigured_site_is_rejected_before_any_link_lookup(jira_client, monkeypatch):
    """Route-before-verify, from the refused end.

    A payload whose host matches no `pz_workspace_integrations` row has no
    secret to be checked against and no account to be attributed to, so it is
    dropped with a 401 before `find_task_link_by_key` is ever called — the same
    "unrecognized identity, untrusted payload" rule `github_webhook` applies to
    an unknown `repo_full_name`.
    """
    (ws_a, pid_a), (_ws_b, pid_b) = _two_sites(jira_client, monkeypatch)

    called: list[tuple] = []
    repo = jira_client.app.state.repository
    original = repo.find_task_link_by_key

    def _spy(*args, **kwargs):
        called.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, "find_task_link_by_key", _spy)

    # A third site nobody configured, signed with a secret it does hold — A's.
    res = _deliver(jira_client, ws_a, _issue_updated("Intruder"), "https://site-c.atlassian.net")
    assert res.status_code == 401
    assert res.json()["detail"] == "unknown_tracker_account"
    assert called == [], f"link lookup ran for an unrecognized account: {called}"
    assert _assignee(jira_client, pid_a, ALICE) is None
    assert _assignee(jira_client, pid_b, BOB) is None


def test_a_link_outliving_its_binding_is_not_reattributed(jira_client, monkeypatch):
    """The second condition in `_resolve_link`, which `account_key` alone does
    not cover.

    Workspace A mirrors a task under site A, then stops using that site;
    workspace B legitimately binds the same site afterwards. B's `account_key` is
    now identical to the one stamped on A's old link rows, so a key-scoped lookup
    alone would hand B's deliveries to A's tasks. The workspace check refuses
    that. Reaching into the repository is deliberate: there is no
    disconnect-tracker route to arrange this through the API, and the branch is
    otherwise unreachable from a test.
    """
    ws_a, pid_a = _site(jira_client, monkeypatch, ALICE, SITE_A, task_id="task-a")
    repo = jira_client.app.state.repository
    # A stops using site A (the settings blob stays; only the binding goes).
    repo._workspace_integrations.pop((ws_a, "jira"))
    # B picks it up, and is issued its own fresh secret.
    ws_b = jira_client.post("/workspaces", json={"name": "B"}, headers=BOB).json()["id"]
    assert (
        jira_client.post(
            f"/workspaces/{ws_b}/integrations/jira",
            json={"base_url": SITE_A, "project_key": PROJECT_KEY},
            headers=BOB,
        ).status_code
        == 200
    )

    # B's own, correctly signed delivery for what B believes is its PZ-1.
    res = _deliver(jira_client, ws_b, _issue_updated("From site A, now B's"), SITE_A)
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 0, "B's delivery was applied to A's task"
    assert _assignee(jira_client, pid_a, ALICE) is None


def test_two_workspaces_cannot_bind_the_same_site(jira_client, monkeypatch):
    """The `unique (provider, account_key)` half of the fix.

    Without it, two workspaces could hold one `account_key` and an inbound
    delivery from that site would again have two possible owners.
    """
    _site(jira_client, monkeypatch, ALICE, SITE_A)
    ws_b = jira_client.post("/workspaces", json={"name": "B"}, headers=BOB).json()
    res = jira_client.post(
        f"/workspaces/{ws_b['id']}/integrations/jira",
        json={"base_url": SITE_A, "project_key": PROJECT_KEY},
        headers=BOB,
    )
    assert res.status_code == 409
    assert res.json()["detail"] == f"tracker_account_already_bound:{SITE_A}"


def test_reconfiguring_the_same_site_keeps_its_secret(jira_client, monkeypatch):
    """A saved settings change must not silently invalidate the webhook the
    admin already registered on the Jira side."""
    ws_a, _pid_a = _site(jira_client, monkeypatch, ALICE, SITE_A)
    before = account_secret(jira_client, ws_a)
    res = jira_client.post(
        f"/workspaces/{ws_a}/integrations/jira",
        json={"base_url": f"{SITE_A}/", "project_key": PROJECT_KEY, "status_map": {}},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert account_secret(jira_client, ws_a) == before
    # The trailing slash normalizes away rather than creating a second account.
    integration = jira_client.app.state.repository.get_workspace_integration(ws_a, "jira")
    assert integration.account_key == SITE_A


# --------------------------------------------------------------------------- #
# 2. Identical comment identifiers, no cross-project mirroring
# --------------------------------------------------------------------------- #
def _comment_created(comment_id: str, body: str) -> dict:
    return {
        "webhookEvent": "comment_created",
        "issue": {"key": ISSUE_KEY},
        "comment": {"id": comment_id, "author": {"displayName": "Reviewer"}, "body": body},
    }


def test_identical_comment_ids_on_two_sites_produce_two_discussions(jira_client, monkeypatch):
    """Guards the `f"{provider}-{account_key}-comment-{comment_id}"` id.

    A Jira comment id is internal to its own site, so two tenants' PZ-1 each
    getting comment `10001` used to produce the same `jira-comment-10001` — and
    the second delivery's upsert overwrote the first workspace's discussion row.
    """
    (ws_a, pid_a), (ws_b, pid_b) = _two_sites(jira_client, monkeypatch)

    res_a = _deliver(jira_client, ws_a, _comment_created("10001", "A's comment"), SITE_A)
    assert res_a.status_code == 200, res_a.text
    assert res_a.json()["applied"] == 1

    res_b = _deliver(jira_client, ws_b, _comment_created("10001", "B's comment"), SITE_B)
    assert res_b.status_code == 200, res_b.text
    assert res_b.json()["applied"] == 1

    a = jira_client.get(f"/sync/projects/{pid_a}/graph", headers=ALICE).json()["discussions"]
    b = jira_client.get(f"/sync/projects/{pid_b}/graph", headers=BOB).json()["discussions"]
    assert len(a) == 1 and len(b) == 1
    assert a[0]["body"] == "A's comment"  # not overwritten by B's delivery
    assert b[0]["body"] == "B's comment"
    assert a[0]["id"] != b[0]["id"]
    assert a[0]["id"] == f"jira-{SITE_A}-comment-10001"
    assert b[0]["id"] == f"jira-{SITE_B}-comment-10001"


def test_comment_redelivery_is_still_idempotent_per_site(jira_client, monkeypatch):
    """The account_key in the id must not cost the determinism it was there
    for: the same site re-delivering the same comment still upserts one row."""
    (ws_a, pid_a), _b = _two_sites(jira_client, monkeypatch)
    first = _deliver(jira_client, ws_a, _comment_created("10001", "first"), SITE_A)
    assert first.status_code == 200, first.text
    again = _deliver(jira_client, ws_a, _comment_created("10001", "edited"), SITE_A)
    assert again.status_code == 200, again.text
    rows = jira_client.get(f"/sync/projects/{pid_a}/graph", headers=ALICE).json()["discussions"]
    assert len(rows) == 1
    assert rows[0]["body"] == "edited"


# --------------------------------------------------------------------------- #
# 3. Repeated mirror, no duplicate issue
# --------------------------------------------------------------------------- #
def test_repeated_mirror_returns_the_existing_link_without_a_second_create(
    jira_client, monkeypatch
):
    """Finding 15. The route used to send the create unconditionally and then
    overwrite the task's link, so a retry left an orphaned external issue
    behind. The counting transport is what makes "no second create" checkable —
    a duplicated issue is otherwise indistinguishable from a successful mirror.
    """
    ws = jira_client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    pid = jira_client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]
    jira_client.put(
        f"/sync/projects/{pid}/graph",
        json={"tasks": [{"id": "t1", "project_id": pid, "title": "Login"}]},
        headers=ALICE,
    )
    assert (
        jira_client.post(
            f"/workspaces/{ws['id']}/integrations/jira",
            json={"base_url": SITE_A, "project_key": PROJECT_KEY},
            headers=ALICE,
        ).status_code
        == 200
    )

    import app.api.integrations as integ

    send = _CountingSend()
    monkeypatch.setattr(integ, "_send", send)

    first = jira_client.post(
        f"/projects/{pid}/tasks/t1/mirror", params={"provider": "jira"}, headers=ALICE
    )
    assert first.status_code == 200, first.text
    assert len(send.calls) == 1

    second = jira_client.post(
        f"/projects/{pid}/tasks/t1/mirror", params={"provider": "jira"}, headers=ALICE
    )
    assert second.status_code == 200, second.text
    assert len(send.calls) == 1, f"a second outbound create was sent: {send.calls}"
    assert second.json()["external_key"] == first.json()["external_key"]
    assert second.json()["account_key"] == first.json()["account_key"]
    assert second.json() == first.json()
