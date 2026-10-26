"""Plan 0034 task 1: `pw_applied_migrations()` is service-only, against real Postgres.

Migration 0015 revokes execute from public, anon and authenticated and grants it
to service_role. A member JWT calling the function over REST must be refused
with a privilege error (42501), not served the ledger filenames.

Same harness, environment variables and skip behaviour as
`tests/rls/test_governance_table_grants.py` — see `tests/rls/conftest.py`.
"""

from __future__ import annotations

import httpx
import pytest

from tests.rls.conftest import INSUFFICIENT_PRIVILEGE, Fixture, Target

pytestmark = pytest.mark.rls


def test_member_cannot_call_pw_applied_migrations(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    res = http.post(
        f"{target.rest}/rpc/pw_applied_migrations",
        headers=target.user_headers(fixture.member.access_token),
        json={},
    )
    assert res.status_code in (401, 403), (
        f"expected a privilege refusal, got {res.status_code}: {res.text}"
    )
    body = res.json()
    assert body.get("code") == INSUFFICIENT_PRIVILEGE, (
        f"expected SQLSTATE {INSUFFICIENT_PRIVILEGE} (permission denied), got: {body}"
    )
