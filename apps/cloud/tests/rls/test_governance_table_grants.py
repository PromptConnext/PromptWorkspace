"""Plan 0033 M5 — `pw_workspace_governance` is service-only, against real Postgres.

Migration 0011 enables RLS on the table with no policy and revokes the
`authenticated`/`anon` default grants, so only `service_role` (i.e. `apps/cloud`)
can touch it. This is the table that would have 500'd the workspace home page
had it not been listed in `_SERVICE_ONLY_TABLES`: the page reads it through the
service-role client, and a for-user client would be refused here. The probe
keeps that grant posture honest — a later migration that re-granted the table to
`authenticated` would let a member read or rewrite their workspace's governance
without going through the admin-checked route, and nothing in the default
`DATA_BACKEND=memory` suite could notice.

Same harness, environment variables and skip behaviour as
`tests/rls/test_tracker_integration_grants.py` — see `tests/rls/conftest.py`.
"""

from __future__ import annotations

import httpx
import pytest

from tests.rls.conftest import INSUFFICIENT_PRIVILEGE, Fixture, Target

pytestmark = pytest.mark.rls

_TABLE = "pw_workspace_governance"


def _denied(res: httpx.Response) -> None:
    """A privilege refusal, not a silent empty result: a policy declining a row
    is a 200 with `[]`, which would let a missing grant pass for "nothing
    matched"."""
    assert res.status_code in (401, 403), (
        f"expected a privilege refusal, got {res.status_code}: {res.text}"
    )
    body = res.json()
    assert body.get("code") == INSUFFICIENT_PRIVILEGE, (
        f"expected SQLSTATE {INSUFFICIENT_PRIVILEGE} (permission denied), got: {body}"
    )


def test_member_cannot_read_workspace_governance(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    res = http.get(
        f"{target.rest}/{_TABLE}",
        headers=target.user_headers(fixture.member.access_token),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "select": "*"},
    )
    _denied(res)


def test_member_cannot_write_workspace_governance(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    res = http.post(
        f"{target.rest}/{_TABLE}",
        headers=target.user_headers(fixture.member.access_token),
        json={
            "workspace_id": fixture.workspace_id,
            "policy_scope": {"policies": [], "text": "chosen by the member"},
            "required_hats": [],
            "require_seeded_rules": False,
            "updated_by": fixture.member.id,
        },
    )
    _denied(res)

    # Read back as the one role that keeps its grants: nothing was written.
    check = http.get(
        f"{target.rest}/{_TABLE}",
        headers=target.service_headers(),
        params={"workspace_id": f"eq.{fixture.workspace_id}", "select": "*"},
    )
    assert check.status_code == 200, check.text
    assert check.json() == [], "a member wrote a governance row"
