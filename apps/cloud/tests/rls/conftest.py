"""Fixtures for the direct-PostgREST grant probes (plan 0014 M4).

WHY THIS PACKAGE IS NOT `tests/contract/`
`tests/contract/` (plan 0020) tests the Python `Repository` interface: it holds
a `SupabaseRepository` built on the *service-role* key and asserts that both
adapters behave alike. That harness cannot see the defect plan 0014 fixes,
because the defect is not in any Python method — it is a Postgres `GRANT`. The
attack it describes never calls `apps/cloud` at all: a signed-in browser
session takes its own Supabase JWT to the PostgREST data API and writes rows
the FastAPI routes would have refused. So the cases here issue **raw HTTP** at
`{url}/rest/v1/...` with a real end-user's bearer token and never import a
repository class. Nothing in the default, `DATA_BACKEND=memory` suite can fail
if migration 0030 is wrong (`InMemoryRepository` has no concept of a grant);
these cases are the only ones that can.

ENVIRONMENT
Three dedicated variables, deliberately *not* `SUPABASE_URL`/`SUPABASE_KEY`
(the root `tests/conftest.py` deletes those before `app.config` is imported)
and deliberately *not* `PROMPTWORKSPACE_CONTRACT_SUPABASE_*` either: this harness needs a
third value plan 0020's has no use for — the **anon key**, which is the
`apikey` a browser presents to GoTrue to sign up and to PostgREST alongside a
user JWT. Reusing `PROMPTWORKSPACE_CONTRACT_SUPABASE_KEY` for it would silently hand these
probes a service-role token, which bypasses RLS *and* keeps its grants, and
every assertion below would pass for the wrong reason.

    PROMPTWORKSPACE_RLS_SUPABASE_URL          # e.g. http://127.0.0.1:54321 (the API, not the db)
    PROMPTWORKSPACE_RLS_SUPABASE_ANON_KEY     # `ANON_KEY` from `supabase start`
    PROMPTWORKSPACE_RLS_SUPABASE_SERVICE_KEY  # `SERVICE_ROLE_KEY` from `supabase start`

Unset (the default, and the state of every ordinary `pytest` run) means each
case **skips with a reason naming the missing variable** — never silently
dropped. `PROMPTWORKSPACE_RLS_REQUIRE_SUPABASE=1` turns that skip into a failure, for a job
whose whole purpose is to reach the database (mirrors plan 0020's
`PROMPTWORKSPACE_CONTRACT_REQUIRE_SUPABASE`).

STANDING THE TARGET UP, from the repository root:

    supabase start                                    # db on :54322, API on :54321
    cd apps/cloud
    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \\
      scripts/migrate.py apply --var embed_dim=1024   # 0023 refuses without the var
    export PROMPTWORKSPACE_RLS_SUPABASE_URL=http://127.0.0.1:54321
    export PROMPTWORKSPACE_RLS_SUPABASE_ANON_KEY=<ANON_KEY from `supabase start`>
    export PROMPTWORKSPACE_RLS_SUPABASE_SERVICE_KEY=<SERVICE_ROLE_KEY from `supabase start`>
    pytest -q -m rls

No extra grant is needed any more: a local stack, like a new hosted project,
does not expose migration-created tables to the Data API roles
(`supabase/config.toml`'s `auto_expose_new_tables`, unset), and
`migrations/0005_pw_service_role_grants.sql` now grants `service_role` every
pw_ table this setup writes (`pw_workspaces`, `pw_workspace_members`,
`pw_projects`, ...). A hand grant here would hide a missing one in the schema.

`service_role` is *setup*, not a subject of these cases: the probes run as
`authenticated`, whose privileges are what is under test, and `service_role`
is only how the fixture puts legitimate rows in place and reads them back.

Each case creates fresh uuids for its workspace, project and task and fresh
uuid-local email addresses for its two users, so runs do not collide and
nothing needs cleaning up. `supabase db reset` (then re-apply migrations) is
the reset.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

import httpx
import pytest

_URL_VAR = "PROMPTWORKSPACE_RLS_SUPABASE_URL"
_ANON_VAR = "PROMPTWORKSPACE_RLS_SUPABASE_ANON_KEY"
_SERVICE_VAR = "PROMPTWORKSPACE_RLS_SUPABASE_SERVICE_KEY"
_REQUIRE_VAR = "PROMPTWORKSPACE_RLS_REQUIRE_SUPABASE"

# Postgres' insufficient_privilege. The one SQLSTATE that proves the *grant*
# denied the write, as distinct from an RLS policy declining a row (which
# PostgREST reports as 42501 on INSERT but as an empty 200/204 on UPDATE —
# see tests/rls/test_graph_table_grants.py's note on why that distinction is
# the whole point of this harness).
INSUFFICIENT_PRIVILEGE = "42501"


def _required() -> bool:
    return os.environ.get(_REQUIRE_VAR, "").strip().lower() not in ("", "0", "false", "no")


@dataclass(frozen=True)
class Target:
    """Where the local stack is and which keys open which door."""

    url: str
    anon_key: str
    service_key: str

    @property
    def rest(self) -> str:
        return f"{self.url.rstrip('/')}/rest/v1"

    @property
    def auth(self) -> str:
        return f"{self.url.rstrip('/')}/auth/v1"

    def service_headers(self) -> dict[str, str]:
        return {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    def user_headers(self, access_token: str) -> dict[str, str]:
        """What a browser sends: the project's anon `apikey` plus the signed-in
        user's own JWT. PostgREST resolves the role from the JWT's `role`
        claim, so these calls execute as `authenticated`."""
        return {
            "apikey": self.anon_key,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str
    access_token: str


def resolve_target() -> Target:
    """The configured target, or `pytest.skip`/`pytest.fail` naming what is
    missing. A plain function, not only a fixture, because
    tests/contract/test_for_user_client_split.py needs the same three
    variables — it is the one contract case that requires a real end-user JWT,
    so it needs the anon key the rest of that suite has no use for.
    """
    values = {
        _URL_VAR: os.environ.get(_URL_VAR, "").strip(),
        _ANON_VAR: os.environ.get(_ANON_VAR, "").strip(),
        _SERVICE_VAR: os.environ.get(_SERVICE_VAR, "").strip(),
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        reason = (
            "rls grant probes not configured: "
            + " and ".join(missing)
            + (" is" if len(missing) == 1 else " are")
            + " unset (see tests/rls/conftest.py for the local setup)"
        )
        if _required():
            pytest.fail(f"{reason}; {_REQUIRE_VAR} forbids skipping it", pytrace=False)
        pytest.skip(reason)
    return Target(
        url=values[_URL_VAR],
        anon_key=values[_ANON_VAR],
        service_key=values[_SERVICE_VAR],
    )


@pytest.fixture(scope="session")
def target() -> Target:
    return resolve_target()


@pytest.fixture(scope="session")
def http() -> httpx.Client:
    with httpx.Client(timeout=30.0) as client:
        yield client


def signup(client: httpx.Client, target: Target) -> AuthUser:
    """A real GoTrue user with a real JWT.

    `supabase/config.toml` sets `enable_confirmations = false` locally, so
    signup returns a session immediately — the same ES256/RS256-or-HS256 token
    `app/dependencies.py::_verify_jwt` accepts, and the same one the browser
    would hand to PostgREST.
    """
    email = f"pz-rls-{uuid.uuid4().hex[:12]}@example.com"
    password = f"pw-{uuid.uuid4().hex}"
    res = client.post(
        f"{target.auth}/signup",
        headers={"apikey": target.anon_key, "Content-Type": "application/json"},
        json={"email": email, "password": password},
    )
    assert res.status_code == 200, f"signup failed: {res.status_code} {res.text}"
    body = res.json()
    token = body.get("access_token")
    user = body.get("user") or {}
    assert token, f"signup returned no session (email confirmation on?): {body}"
    return AuthUser(id=user["id"], email=email, access_token=token)


@dataclass(frozen=True)
class Fixture:
    """A legitimate workspace: one admin, one member, one project, one task
    already assigned to the admin.

    Every row is written as `service_role`, i.e. the way `apps/cloud` writes
    them — the point of the probes is what the *member* can then do to these
    rows without going through `apps/cloud`, so the setup must not itself
    depend on the grants under test.
    """

    admin: AuthUser
    member: AuthUser
    workspace_id: str
    project_id: str
    task_id: str


@pytest.fixture
def fixture(http: httpx.Client, target: Target) -> Fixture:
    admin = signup(http, target)
    member = signup(http, target)
    headers = target.service_headers()

    workspace_id = str(uuid.uuid4())
    project_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())

    def insert(table: str, row: dict) -> None:
        res = http.post(f"{target.rest}/{table}", headers=headers, json=row)
        assert res.status_code in (200, 201), f"setup {table} failed: {res.status_code} {res.text}"

    insert("pw_workspaces", {"id": workspace_id, "name": "rls-probe", "created_by": admin.id})
    insert(
        "pw_workspace_members",
        {
            "workspace_id": workspace_id,
            "user_id": admin.id,
            "role": "admin",
            "email": admin.email,
        },
    )
    # The attacker in every probe below: a genuine, non-malicious *member*.
    # Membership is real, which is what makes `pw_is_member` — the only
    # predicate the graph-table policies test — evaluate true for them.
    insert(
        "pw_workspace_members",
        {
            "workspace_id": workspace_id,
            "user_id": member.id,
            "role": "member",
            "email": member.email,
        },
    )
    insert(
        "pw_projects",
        {
            "id": project_id,
            "workspace_id": workspace_id,
            "name": "rls-probe",
            "owner_id": admin.id,
        },
    )
    insert(
        "pw_tasks",
        {
            "id": task_id,
            "project_id": project_id,
            "title": "somebody else's task",
            "status": "todo",
            # Owned by the admin, so probe 3's reassignment is a genuine
            # steal — not the self-assign branch sync.py:550-554 permits.
            "assigned_user_id": admin.id,
        },
    )
    return Fixture(
        admin=admin,
        member=member,
        workspace_id=workspace_id,
        project_id=project_id,
        task_id=task_id,
    )
