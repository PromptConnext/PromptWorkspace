"""`for_user()` keeps the graph tables on the service-role client.

This is the one invariant in plan 0014 whose failure is a *total production
write outage* rather than a security hole, and until this case existed nothing
in the suite touched it. `app/dependencies.py::get_repository` returns
`repo.for_user(token)` for every authenticated request in
`auth_mode="supabase"`, so that object is what every router calls. Migration
0031 leaves `authenticated` with no privilege on the seven graph tables, so if
`for_user` ever routed one of them through its JWT-scoped client, every task
write, stage-document save and comment in production would fail with
`permission denied for table ...`.

The rest of `tests/contract/` cannot catch that. Its `repo` fixture builds
`SupabaseRepository(url, service_key)` directly, so `_service_client is
_client` there and the split never fires; the memory parameter has no clients
at all. Hence a module of its own, and the one case in this package that is
deliberately supabase-only.

It also pins the *other* half of the claim the docstrings make: scoping is
still real outside that set. A repository scoped to a user who is not a member
of a workspace must not see that workspace, while the unscoped one must — if
that stopped holding, `for_user` would have silently become a no-op and the
narrowed claims in `app/api/_guards.py` and `app/dependencies.py` would be
wrong in the opposite direction.

Needs the same three variables as `tests/rls/` (a real end-user JWT means a
real GoTrue signup, which needs the anon key), not just
`PZ_CONTRACT_SUPABASE_*`; it skips naming whichever is missing.
"""

from __future__ import annotations

import httpx
import pytest

from app.db.supabase_repository import SupabaseRepository
from app.models.schemas import GraphUpsertRequest, Task, TaskStatus, new_id, utcnow
from tests.rls.conftest import resolve_target, signup

pytestmark = pytest.mark.contract


@pytest.fixture
def scoped_and_base() -> tuple[SupabaseRepository, SupabaseRepository, str, str]:
    """(base, scoped, workspace_id, user_id) — `scoped` is exactly what
    `get_repository` hands a router for a signed-in request."""
    target = resolve_target()
    with httpx.Client(timeout=30.0) as http:
        user = signup(http, target)
    base = SupabaseRepository(target.url, target.service_key)
    ws = base.create_workspace(f"for-user-{new_id()[:8]}", user.id, created_by_email=user.email)
    return base, base.for_user(user.access_token), ws.id, user.id


def test_scoped_repository_still_writes_graph_tables(
    scoped_and_base: tuple[SupabaseRepository, SupabaseRepository, str, str],
) -> None:
    """Every graph-table method a router reaches for, on the scoped object,
    against a database where `authenticated` has no grant at all."""
    base, scoped, workspace_id, user_id = scoped_and_base
    project = base.create_project(workspace_id, user_id, f"for-user-{new_id()[:8]}")

    task_id = new_id()
    counts, _ = scoped.upsert_graph(
        project.id,
        GraphUpsertRequest(tasks=[Task(id=task_id, project_id=project.id, title="scoped write")]),
    )
    assert counts == {"tasks": 1}

    assert scoped.get_task(project.id, task_id) is not None
    assert scoped.set_task_status(
        project.id, task_id, TaskStatus.verified, utcnow()
    ).status is TaskStatus.verified
    assert scoped.assign_task(project.id, task_id, user_id, utcnow()).assigned_user_id == user_id
    assert (
        scoped.upsert_stage_document(project.id, workspace_id, "plan", "# body", user_id).stage
        == "plan"
    )
    assert len(scoped.get_graph(project.id).tasks) == 1


def test_scoping_is_still_real_outside_the_graph_tables(
    scoped_and_base: tuple[SupabaseRepository, SupabaseRepository, str, str],
) -> None:
    """`for_user` must not have quietly become a no-op: pz_workspaces keeps its
    grant and its `pz_is_member` policy, so a workspace this user does not
    belong to is invisible to the scoped client and visible to the base one."""
    base, scoped, own_workspace_id, _ = scoped_and_base
    stranger = new_id()
    other = base.create_workspace(f"not-yours-{new_id()[:8]}", stranger)

    assert scoped.get_workspace(other.id) is None, "scoped client saw a non-member's workspace"
    assert base.get_workspace(other.id) is not None, "service-role client lost its own visibility"
    assert scoped.get_workspace(own_workspace_id) is not None, "scoped client lost its own"
