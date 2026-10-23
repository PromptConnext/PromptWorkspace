"""Plan 0014 M4 — a member's own JWT, straight at PostgREST, must be refused.

Each case below is one row of plan 0014's gap matrix — plus two for
`pw_discussions`, which that matrix omitted — executed the way the matrix says
a client could execute it: raw HTTP at the Supabase data API, with a real
workspace member's real Supabase Auth token, never touching `apps/cloud`.
Before migration 0031 every one of them **succeeded** — the graph-table
policies test `pw_is_member` and nothing else, and `authenticated` held
`select, insert, update, delete` outright (`migrations/0002_pw_baseline.sql`,
sections `0006_grants.sql`, `0011_discussions.sql` and `0019_stage_documents.sql`).
The API's own refusals (`app/api/_guards.py`, `app/api/sync.py`'s
`set_task_status`/`assign_task`, `ADMIN_ONLY_STAGES`, and plan 0015's
`discussion_author_forbidden`/`discussion_forbidden`) were never in the path.

WHY THE ASSERTION IS ON THE *GRANT*, NOT ON A POLICY
An RLS policy that declines a row makes an `UPDATE` a no-op: PostgREST answers
200 with an empty array, indistinguishable from "no row matched". A missing
base grant makes Postgres refuse before policy evaluation runs at all, with
SQLSTATE 42501, which is both loud and unconditional. That ordering — base
GRANT checked before RLS — is exactly what the comment in `migrations/0002_pw_baseline.sql`,
section `0006_grants.sql`, describes, and it is why plan 0014 chose Option A (revoke) over
Option B (more policies). So every case asserts two things: the request was
refused with 42501, *and* the row is unchanged when read back with the
service-role key. The second assertion is the one that would still catch a
future Supabase release changing how 42501 is surfaced over HTTP.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.rls.conftest import INSUFFICIENT_PRIVILEGE, Fixture, Target

pytestmark = pytest.mark.rls


def _denied(res: httpx.Response) -> None:
    """Assert a PostgREST response is a privilege refusal, not a silent no-op.

    PostgREST maps 42501 to 401 or 403 depending on version (it moved to 403
    in v12); both are accepted, the SQLSTATE is what is pinned. A 2xx here is
    the vulnerability, and the message says so rather than leaving a reviewer
    to decode an assertion on a status code.
    """
    assert res.status_code in (401, 403), (
        f"expected a privilege refusal, got {res.status_code}: {res.text}"
    )
    body = res.json()
    assert body.get("code") == INSUFFICIENT_PRIVILEGE, (
        f"expected SQLSTATE {INSUFFICIENT_PRIVILEGE} (permission denied), got: {body}"
    )


def _read_task(http: httpx.Client, target: Target, task_id: str) -> dict:
    """Read back as service_role — the one role that keeps its grants."""
    res = http.get(
        f"{target.rest}/pw_tasks",
        headers=target.service_headers(),
        params={"id": f"eq.{task_id}", "select": "*"},
    )
    assert res.status_code == 200, res.text
    rows = res.json()
    assert len(rows) == 1, f"task {task_id} not found: {rows}"
    return rows[0]


def test_member_cannot_verify_a_task_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """Matrix row 2: `verified` is admin-only in `sync.py:593-600`
    (`403 verified_requires_admin`), and was member-writable in Postgres."""
    res = http.patch(
        f"{target.rest}/pw_tasks",
        headers=target.user_headers(fixture.member.access_token),
        params={"id": f"eq.{fixture.task_id}"},
        json={"status": "verified"},
    )
    _denied(res)
    assert _read_task(http, target, fixture.task_id)["status"] == "todo"


def test_member_cannot_author_an_admin_only_stage_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """Matrix row 1: `plan` is in `ADMIN_ONLY_STAGES`
    (`app/api/_guards.py`), and `pw_stage_documents_write` tested only
    `pw_is_member(workspace_id)`."""
    res = http.post(
        f"{target.rest}/pw_stage_documents",
        headers=target.user_headers(fixture.member.access_token),
        json={
            "workspace_id": fixture.workspace_id,
            "project_id": fixture.project_id,
            "stage": "plan",
            "content": "# authored by a plain member, around the API",
            "created_by": fixture.member.id,
        },
    )
    _denied(res)
    check = http.get(
        f"{target.rest}/pw_stage_documents",
        headers=target.service_headers(),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    assert check.status_code == 200, check.text
    assert check.json() == [], "a member's direct stage-document write landed"


def test_member_cannot_steal_a_task_assignment_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """Matrix row 3: reassignment is admin-only unless it is a self-assign or
    self-unassign (`sync.py:550-554`). The task is the admin's; a member
    pointing `assigned_user_id` at themselves is the steal that rule exists to
    stop, and no row-level predicate existed for it."""
    res = http.patch(
        f"{target.rest}/pw_tasks",
        headers=target.user_headers(fixture.member.access_token),
        params={"id": f"eq.{fixture.task_id}"},
        json={"assigned_user_id": fixture.member.id},
    )
    _denied(res)
    assert _read_task(http, target, fixture.task_id)["assigned_user_id"] == fixture.admin.id


def test_member_cannot_forge_a_comment_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """pw_discussions, which plan 0014's matrix omitted and the first pass
    missed. `create_discussion` never takes `author` from the client, and
    plan 0015 carried that rule onto the graph door
    (`discussion_author_forbidden` / `discussion_forbidden`) — but both live
    in Python, and 0002_pw_baseline.sql section 0011_discussions.sql granted `authenticated` full
    DML
    behind a membership-only policy. So a member could post a comment
    attributed to the admin, straight at PostgREST. Same bypass class as the
    other six; it needed the grant, not a new rule."""
    res = http.post(
        f"{target.rest}/pw_discussions",
        headers=target.user_headers(fixture.member.access_token),
        json={
            "project_id": fixture.project_id,
            "parent_node_type": "tasks",
            "parent_node_id": fixture.task_id,
            # The forgery: a statement attributed to somebody who never made it.
            "author": fixture.admin.id,
            "body": "Signed off by me, the admin.",
            "source": "pz",
        },
    )
    _denied(res)
    check = http.get(
        f"{target.rest}/pw_discussions",
        headers=target.service_headers(),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    assert check.status_code == 200, check.text
    assert check.json() == [], "a member's forged comment landed"


def test_member_cannot_overwrite_another_members_comment_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """The other half of plan 0015's discussion rules: `body` and `author` are
    "shared" authority, so a direct UPDATE could rewrite an existing comment's
    text and reassign its authorship. The comment here is the admin's, written
    on the service key the way apps/cloud writes it."""
    discussion_id = str(uuid.uuid4())
    seed = http.post(
        f"{target.rest}/pw_discussions",
        headers=target.service_headers(),
        json={
            "id": discussion_id,
            "project_id": fixture.project_id,
            "parent_node_type": "tasks",
            "parent_node_id": fixture.task_id,
            "author": fixture.admin.id,
            "body": "Original, by the admin.",
            "source": "pz",
        },
    )
    assert seed.status_code in (200, 201), seed.text

    res = http.patch(
        f"{target.rest}/pw_discussions",
        headers=target.user_headers(fixture.member.access_token),
        params={"id": f"eq.{discussion_id}"},
        json={"body": "Rewritten by somebody else.", "author": fixture.member.id},
    )
    _denied(res)
    check = http.get(
        f"{target.rest}/pw_discussions",
        headers=target.service_headers(),
        params={"id": f"eq.{discussion_id}", "select": "body,author"},
    )
    assert check.json() == [{"body": "Original, by the admin.", "author": fixture.admin.id}]


def test_member_cannot_write_a_repo_analysis_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """Plan 0027, migration 0034: `pw_repo_analyses` is born service-only.
    Analysing a repository and editing its baseline are admin-only in
    `app/api/repo_analysis.py` and nowhere else, and the baseline is what an
    imported project's plan and tasks are generated against — so a member
    planting one straight through PostgREST would open the planning gate and
    steer every later stage. 0002_pw_baseline.sql section 0006_grants.sql's default privileges would
    have
    granted exactly that; the migration's revoke is what this pins."""
    res = http.post(
        f"{target.rest}/pw_repo_analyses",
        headers=target.user_headers(fixture.member.access_token),
        json={
            "project_id": fixture.project_id,
            "workspace_id": fixture.workspace_id,
            "commit_sha": "c0ffee",
            "snapshot": {},
            "baseline": "# planted by a member, around the API",
            "status": "baseline_ready",
            "created_by": fixture.member.id,
        },
    )
    _denied(res)
    check = http.get(
        f"{target.rest}/pw_repo_analyses",
        headers=target.service_headers(),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    assert check.status_code == 200, check.text
    assert check.json() == [], "a member's direct repo-analysis write landed"

    read = http.get(
        f"{target.rest}/pw_repo_analyses",
        headers=target.user_headers(fixture.member.access_token),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    _denied(read)


def test_member_cannot_write_stage_inputs_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """Migration 0003: `pw_stage_inputs` is born service-only. The answers to
    `plan` and `constitution` are admin-only to write in
    `app/api/_guards.py::require_stage_access` and nowhere else; the default
    privileges would have handed every member a direct write around it."""
    res = http.post(
        f"{target.rest}/pw_stage_inputs",
        headers=target.user_headers(fixture.member.access_token),
        json={
            "project_id": fixture.project_id,
            "workspace_id": fixture.workspace_id,
            "stage": "plan",
            "inputs": {"language": "planted by a member, around the API"},
            "updated_by": fixture.member.id,
        },
    )
    _denied(res)
    check = http.get(
        f"{target.rest}/pw_stage_inputs",
        headers=target.service_headers(),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    assert check.status_code == 200, check.text
    assert check.json() == [], "a member's direct stage-inputs write landed"

    read = http.get(
        f"{target.rest}/pw_stage_inputs",
        headers=target.user_headers(fixture.member.access_token),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    _denied(read)


@pytest.mark.parametrize(
    ("table", "row"),
    [
        (
            "pw_delivery_changes",
            lambda f: {"project_id": f.project_id, "workspace_id": f.workspace_id, "ref": "C1",
                       "key": "setup", "title": "planted", "kind": "setup", "position": 0},
        ),
        (
            "pw_project_roles",
            lambda f: {"project_id": f.project_id, "workspace_id": f.workspace_id,
                       "hat": "tech_steward", "user_id": f.member.id,
                       "assigned_by": f.member.id},
        ),
        (
            "pw_decisions",
            lambda f: {"project_id": f.project_id, "workspace_id": f.workspace_id,
                       "kind": "plan_approval", "title": "planted", "subject_stage": "tasks",
                       "subject_hash": "x", "routed_hat": "tech_steward", "status": "approved",
                       "requested_by": f.member.id, "resolved_by": f.member.id},
        ),
    ],
)
def test_member_cannot_touch_delivery_tables_directly(
    http: httpx.Client, target: Target, fixture: Fixture, table: str, row
) -> None:
    """Migration 0004: the plan 0029 tables are born service-only. A member
    who could insert a decision with status `approved` would approve a plan
    around `app/api/delivery.py`."""
    res = http.post(
        f"{target.rest}/{table}",
        headers=target.user_headers(fixture.member.access_token),
        json=row(fixture),
    )
    _denied(res)
    read = http.get(
        f"{target.rest}/{table}",
        headers=target.user_headers(fixture.member.access_token),
        params={"project_id": f"eq.{fixture.project_id}", "select": "*"},
    )
    _denied(read)


def test_member_cannot_read_graph_tables_directly_either(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """`revoke all` takes SELECT too, so the data API stops being a read path
    for these tables as well. Recorded as its own case because it is a real
    behaviour change beyond the three writes the plan names: a client that
    read `pw_tasks` over PostgREST today would break, and plan 0014's
    recommendation rests on the claim that no such client exists
    (`apps/web/src/lib/auth.tsx` uses supabase-js for sessions only; every
    graph read goes through `apiFetch`). If that claim ever stops holding,
    this is the case that says where to look.
    """
    res = http.get(
        f"{target.rest}/pw_tasks",
        headers=target.user_headers(fixture.member.access_token),
        params={"id": f"eq.{fixture.task_id}", "select": "*"},
    )
    _denied(res)


@pytest.mark.parametrize(
    "patch",
    [
        {"repo_origin": "created"},
        {"repo_url": "https://github.com/attacker/elsewhere"},
        {"lifecycle_status": "tech_review"},
    ],
    ids=["repo_origin", "repo_url", "lifecycle_status"],
)
def test_member_cannot_write_server_owned_project_columns(
    http: httpx.Client, target: Target, fixture: Fixture, patch: dict
) -> None:
    """Plan 0027 N1, migration 0036: `pw_projects` is written by the server
    only. `repo_origin` decides whether an adopted repository gets the
    overwriting seed, and `repo_url` which repository the platform writes
    secrets, a webhook and a seed commit into — both were a member's to set
    through PostgREST while `pw_projects_rw` tested membership alone."""
    res = http.patch(
        f"{target.rest}/pw_projects",
        headers=target.user_headers(fixture.member.access_token),
        params={"id": f"eq.{fixture.project_id}"},
        json=patch,
    )
    _denied(res)
    check = http.get(
        f"{target.rest}/pw_projects",
        headers=target.service_headers(),
        params={"id": f"eq.{fixture.project_id}", "select": ",".join(patch)},
    )
    assert check.status_code == 200, check.text
    assert check.json() != [patch], "a member's direct project write landed"


def test_member_cannot_insert_or_delete_a_project_directly(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    headers = target.user_headers(fixture.member.access_token)
    planted = str(uuid.uuid4())
    _denied(
        http.post(
            f"{target.rest}/pw_projects",
            headers=headers,
            json={
                "id": planted,
                "workspace_id": fixture.workspace_id,
                "name": "planted",
                "owner_id": fixture.member.id,
                "repo_origin": "created",
            },
        )
    )
    _denied(
        http.delete(
            f"{target.rest}/pw_projects",
            headers=headers,
            params={"id": f"eq.{fixture.project_id}"},
        )
    )
    rows = http.get(
        f"{target.rest}/pw_projects",
        headers=target.service_headers(),
        params={"id": f"in.({planted},{fixture.project_id})", "select": "id"},
    ).json()
    assert rows == [{"id": fixture.project_id}]


def test_member_still_reads_their_own_project(
    http: httpx.Client, target: Target, fixture: Fixture
) -> None:
    """0036 revokes writes only: the scoped read `list_projects` and
    `get_project` depend on is still granted and still membership-scoped."""
    res = http.get(
        f"{target.rest}/pw_projects",
        headers=target.user_headers(fixture.member.access_token),
        params={"id": f"eq.{fixture.project_id}", "select": "id"},
    )
    assert res.status_code == 200, res.text
    assert res.json() == [{"id": fixture.project_id}]
