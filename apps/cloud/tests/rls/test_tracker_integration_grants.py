"""Plan 0019 M1, against real Postgres — the parts no Python test can reach.

Two claims in migration 0032 are claims about the *database*, and
`InMemoryRepository` has no concept of either, so nothing in the default
`DATA_BACKEND=memory` suite can fail if the migration is wrong:

  1. `pz_workspace_integrations.webhook_secret_ref` never reaches a browser
     session. The table deliberately keeps a `pz_is_member` read policy — unlike
     `pz_repo_webhooks`, its non-secret columns are a workspace's own settings —
     so the secret is held back by a *column-level* grant, not by the row
     policy. The distinction matters: a reviewer who sees "RLS enabled, member
     policy" on a table holding webhook secrets should be able to point at the
     case that proves the secret is still out of reach.
  2. `pz_task_links`' primary key really is `(provider, account_key,
     external_key)`. That swap is the mechanism of the whole plan; if the
     migration failed to drop the old two-column key, two sites' `PZ-1` would
     still collide in production while every memory-backed test passed.

Same harness, environment variables and skip behaviour as
`tests/rls/test_graph_table_grants.py` — see `tests/rls/conftest.py` for the
local setup recipe.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.rls.conftest import INSUFFICIENT_PRIVILEGE, Fixture, Target

pytestmark = pytest.mark.rls

_SECRET = "ciphertext-nobody-outside-the-server-may-read"
_ACCOUNT = "https://pz-rls-probe.atlassian.net"


def _denied(res: httpx.Response) -> None:
    """A privilege refusal, not a silent empty result. Copied in shape from
    tests/rls/test_graph_table_grants.py::_denied and for the same reason: a
    policy declining a row is a 200 with `[]`, which would let a missing grant
    pass for "nothing matched"."""
    assert res.status_code in (401, 403), (
        f"expected a privilege refusal, got {res.status_code}: {res.text}"
    )
    body = res.json()
    assert body.get("code") == INSUFFICIENT_PRIVILEGE, (
        f"expected SQLSTATE {INSUFFICIENT_PRIVILEGE} (permission denied), got: {body}"
    )


@pytest.fixture
def integration(http: httpx.Client, target: Target, fixture: Fixture) -> str:
    """One tracker binding for the fixture's workspace, written as the server
    writes it — on the service key. Returns its account_key."""
    account_key = f"{_ACCOUNT}/{uuid.uuid4().hex[:8]}"
    res = http.post(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.service_headers(),
        json={
            "workspace_id": fixture.workspace_id,
            "provider": "jira",
            "account_key": account_key,
            "webhook_secret_ref": _SECRET,
        },
    )
    assert res.status_code in (200, 201), f"setup failed: {res.status_code} {res.text}"
    return account_key


def test_member_may_read_the_non_secret_columns(
    http: httpx.Client, target: Target, fixture: Fixture, integration: str
) -> None:
    """The half that is deliberately *allowed* — otherwise a settings UI could
    not show a workspace which site it is connected to."""
    res = http.get(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.user_headers(fixture.member.access_token),
        params={
            "workspace_id": f"eq.{fixture.workspace_id}",
            "select": "workspace_id,provider,account_key",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json() == [
        {
            "workspace_id": fixture.workspace_id,
            "provider": "jira",
            "account_key": integration,
        }
    ]


def test_member_cannot_read_the_webhook_secret(
    http: httpx.Client, target: Target, fixture: Fixture, integration: str
) -> None:
    """The load-bearing case. A member of the very workspace that owns this row
    — so `pz_is_member` is true and the read policy permits the row — still
    cannot see the column, because `authenticated` holds no SELECT on it."""
    named = http.get(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.user_headers(fixture.member.access_token),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "select": "webhook_secret_ref"},
    )
    _denied(named)
    assert _SECRET not in named.text

    # `select=*` is the way a secret leaks by accident, so pin that too.
    star = http.get(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.user_headers(fixture.member.access_token),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "select": "*"},
    )
    _denied(star)
    assert _SECRET not in star.text


def test_member_cannot_write_a_tracker_binding(
    http: httpx.Client, target: Target, fixture: Fixture, integration: str
) -> None:
    """No client-writable path, by design: a member who could INSERT here would
    claim another tenant's `account_key` and re-open the collision migration
    0032 closes — or overwrite their own workspace's secret with one they chose,
    which would let them forge deliveries."""
    inserted = http.post(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.user_headers(fixture.member.access_token),
        json={
            "workspace_id": fixture.workspace_id,
            "provider": "clickup",
            "account_key": f"{_ACCOUNT}/attacker",
            "webhook_secret_ref": "chosen-by-the-attacker",
        },
    )
    _denied(inserted)

    updated = http.patch(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.user_headers(fixture.member.access_token),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "provider": "eq.jira"},
        json={"webhook_secret_ref": "chosen-by-the-attacker"},
    )
    _denied(updated)

    deleted = http.delete(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.user_headers(fixture.member.access_token),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "provider": "eq.jira"},
    )
    _denied(deleted)

    # Read back as the one role that keeps its grants: nothing moved.
    check = http.get(
        f"{target.rest}/pz_workspace_integrations",
        headers=target.service_headers(),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "select": "*"},
    )
    assert check.status_code == 200, check.text
    rows = check.json()
    assert len(rows) == 1
    assert rows[0]["account_key"] == integration
    assert rows[0]["webhook_secret_ref"] == _SECRET


def test_task_links_are_keyed_by_account(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """The primary-key swap, asserted against the constraint itself.

    Two sites reusing a project prefix both produce `PZ-1`. Under the old
    `(provider, external_key)` key the second insert would have conflicted with
    the first and one tenant's link would have won; under
    `(provider, account_key, external_key)` both rows exist, and only a genuine
    re-insert of the *same* triple conflicts.
    """
    headers = target.service_headers()

    def insert(account_key: str) -> httpx.Response:
        return http.post(
            f"{target.rest}/pz_task_links",
            headers=headers,
            json={
                "task_id": fixture.task_id,
                "project_id": fixture.project_id,
                "provider": "jira",
                "account_key": account_key,
                "external_key": "PZ-1",
                "external_url": f"{account_key}/browse/PZ-1",
            },
        )

    site_a = f"https://pz-rls-a-{uuid.uuid4().hex[:8]}.atlassian.net"
    site_b = f"https://pz-rls-b-{uuid.uuid4().hex[:8]}.atlassian.net"
    assert insert(site_a).status_code in (200, 201)
    second = insert(site_b)
    assert second.status_code in (200, 201), (
        "the same issue key on a second site was refused — the primary key is "
        f"still account-blind: {second.status_code} {second.text}"
    )

    # The same triple twice is still one row's worth of identity.
    duplicate = insert(site_a)
    assert duplicate.status_code == 409, (
        f"expected a unique violation on the same (provider, account_key, "
        f"external_key), got {duplicate.status_code}: {duplicate.text}"
    )

    # Scoped to this case's own project: the harness never cleans up (see
    # tests/rls/conftest.py), so an unscoped read would also see PZ-1 rows left
    # by a previous run against the same local stack.
    rows = http.get(
        f"{target.rest}/pz_task_links",
        headers=headers,
        params={
            "project_id": f"eq.{fixture.project_id}",
            "external_key": "eq.PZ-1",
            "select": "account_key",
        },
    ).json()
    assert sorted(r["account_key"] for r in rows) == sorted([site_a, site_b])
