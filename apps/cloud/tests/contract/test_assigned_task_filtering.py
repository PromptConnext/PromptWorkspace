"""Filtering happens before limiting, or the answer is silently short.

Finding 4 of the review. `InMemoryRepository.list_assigned_tasks`
(app/db/repository.py:872) skips projects outside the requested workspace,
re-checks membership, sorts, and only then slices — `return out[:limit]`
(app/db/repository.py:908). `SupabaseRepository.list_assigned_tasks`
(app/db/supabase_repository.py:511) resolves the caller's workspace set first
but then queries tasks filtered only on `assigned_user_id` and `deleted_at` and
truncates immediately — `rows = (q.limit(limit).execute().data) or []`
(app/db/supabase_repository.py:536) — applying the workspace restriction
afterwards, in Python (app/db/supabase_repository.py:545), and the sort after
that (:572). A user with tasks in three workspaces can ask for one workspace and
be handed an empty list.

`tests/test_my_tasks.py` covers both halves separately (`test_workspace_filter`,
`test_limit_caps_results`) and passes, because in memory the two never interact.
These cases make them interact, and the decoy rows are written *first* so a
limit applied before the filter lands on them.

Both cases fail against `SupabaseRepository` today, returning `[]`, which is the
defect the review reported and nothing in the suite could previously show. The
adapter fix is not this plan's — plan 0020 builds the harness, and finding 4's
production repair has no plan of its own yet (the review's own order of work
pairs it with finding 3, which `0013-graph-pagination-contract.md` owns). So the
supabase parameter carries a **strict** xfail: the divergence is recorded rather
than hidden, and the first commit that fixes the adapter turns these into XPASS
and fails the run until the markers go with it.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import Task, TaskStatus, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def _expect_finding_4(repo: Repository, request: pytest.FixtureRequest) -> None:
    """Record the known adapter divergence without hiding it — see the module
    docstring for why the repair is not part of this plan."""
    if repo.backend_name != "supabase":
        return
    request.node.add_marker(
        pytest.mark.xfail(
            reason=(
                "finding 4, unrepaired: SupabaseRepository.list_assigned_tasks "
                "truncates at `limit` before the workspace restriction is applied "
                "(app/db/supabase_repository.py:536 then :545), so this returns []. "
                "Delete this marker with the adapter fix."
            ),
            strict=True,
        )
    )


def _assigned(project_id: str, user_id: str, count: int, status=TaskStatus.todo) -> list[Task]:
    return [
        Task(
            project_id=project_id,
            title=f"task-{index}",
            status=status,
            assigned_user_id=user_id,
        )
        for index in range(count)
    ]


def test_workspace_filter_applies_before_the_limit(
    repo: Repository, request: pytest.FixtureRequest
) -> None:
    _expect_finding_4(repo, request)
    user = new_id()
    target, target_admin = h.workspace(repo, members=(user,))
    noise_a, noise_a_admin = h.workspace(repo, members=(user,))
    noise_b, noise_b_admin = h.workspace(repo, members=(user,))

    target_project = h.project(repo, target, target_admin, name="aaa-target")
    noise_a_project = h.project(repo, noise_a, noise_a_admin, name="bbb-noise")
    noise_b_project = h.project(repo, noise_b, noise_b_admin, name="ccc-noise")

    # Written first, so a `limit` applied before the workspace filter consumes
    # only these — the rows the caller must not be handed.
    noise = _assigned(noise_a_project.id, user, 3) + _assigned(noise_b_project.id, user, 3)
    h.push_tasks(repo, noise_a_project.id, noise[:3])
    h.push_tasks(repo, noise_b_project.id, noise[3:])

    wanted = _assigned(target_project.id, user, 2)
    h.push_tasks(repo, target_project.id, wanted)

    # 8 assigned tasks in total, 2 of them in the workspace under test, and a
    # limit that is larger than that 2 but smaller than the 8.
    limit = 3
    expected = sorted(task.id for task in wanted)
    assert h.assigned_ids(repo, user, workspace_id=target.id, limit=limit) == expected

    # And the ordering the contract promises — (project_name, feature_tag, id) —
    # holds across workspaces when the limit is not the constraint.
    every = h.assigned_ids(repo, user, limit=50)
    assert every == (
        sorted(t.id for t in wanted)
        + sorted(t.id for t in noise[:3])
        + sorted(t.id for t in noise[3:])
    )


def test_status_filter_and_workspace_filter_both_precede_the_limit(
    repo: Repository, request: pytest.FixtureRequest
) -> None:
    _expect_finding_4(repo, request)
    user = new_id()
    target, target_admin = h.workspace(repo, members=(user,))
    noise, noise_admin = h.workspace(repo, members=(user,))

    target_project = h.project(repo, target, target_admin, name="aaa-target")
    noise_project = h.project(repo, noise, noise_admin, name="bbb-noise")

    # Decoys carry the *wanted* status, so the status filter alone cannot save
    # an adapter that truncates before scoping to the workspace.
    decoys = _assigned(noise_project.id, user, 4, status=TaskStatus.verified)
    h.push_tasks(repo, noise_project.id, decoys)

    wanted = _assigned(target_project.id, user, 2, status=TaskStatus.verified)
    unwanted_status = _assigned(target_project.id, user, 2, status=TaskStatus.todo)
    h.push_tasks(repo, target_project.id, wanted + unwanted_status)

    got = h.assigned_ids(
        repo,
        user,
        workspace_id=target.id,
        statuses=[TaskStatus.verified],
        limit=3,
    )
    assert got == sorted(task.id for task in wanted)
