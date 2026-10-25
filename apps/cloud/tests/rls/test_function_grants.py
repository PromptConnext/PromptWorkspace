"""`pw_latest_receipt_at` is service-only, against real Postgres.

Migration 0013 revokes EXECUTE on the function from public, `anon` and
`authenticated` and grants it to `service_role` alone. A repository method that
calls it on the caller's scoped client (the `for_user` client, which carries the
member's JWT) is therefore refused with SQLSTATE 42501, and
`GET /workspaces/{id}/overview` returns 500. The contract suite runs on the
service key and the unit tests use fakes, so nothing else exercised a scoped
client against the function: this is the probe that would have caught it. It
also keeps the grant posture honest the other way round — a later migration that
re-granted the function to `authenticated` would fail here.

Same harness, environment variables and skip behaviour as
`tests/rls/test_governance_table_grants.py` — see `tests/rls/conftest.py`.
"""

from __future__ import annotations

import httpx
import pytest

from tests.rls.conftest import INSUFFICIENT_PRIVILEGE, Fixture, Target

pytestmark = pytest.mark.rls

_FUNCTION = "pw_latest_receipt_at"


def _denied(res: httpx.Response) -> None:
    """A privilege refusal, not a silent empty result."""
    assert res.status_code in (401, 403), (
        f"expected a privilege refusal, got {res.status_code}: {res.text}"
    )
    body = res.json()
    assert body.get("code") == INSUFFICIENT_PRIVILEGE, (
        f"expected SQLSTATE {INSUFFICIENT_PRIVILEGE} (permission denied), got: {body}"
    )


def test_member_cannot_call_the_receipts_function(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    res = http.post(
        f"{target.rest}/rpc/{_FUNCTION}",
        headers=target.user_headers(fixture.member.access_token),
        json={"p_project_ids": []},
    )
    _denied(res)
