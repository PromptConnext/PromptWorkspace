"""Freezing a build's task set is a contract, on either adapter (plan 0024 M2).

The freeze is the one place in this codebase where the two adapters enforce
the same rule by completely different means: the in-memory backend compares a
field and assigns, while `SupabaseRepository` delegates the whole thing —
guard, delete, insert and stamp — to `pz_freeze_deployment_tasks` in migration
0033. Those are two independent implementations of one promise, and a
memory-only suite cannot tell a working Postgres function from a missing one.
It would pass just as happily against a database where the migration was never
applied, which is precisely the failure that matters: attribution would
silently go back to being recomputable on every webhook redelivery.

So the cases here are written as questions about behaviour, never about
mechanism — "does a second freeze change anything", not "was an RPC issued".
The RPC shape is pinned separately and hermetically in
`tests/test_deployment_attribution_adapter.py`; this file is what proves the
thing on the other end of that call actually does its job.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import Deployment, Task, new_id, utcnow

from . import _helpers as h

pytestmark = pytest.mark.contract


def _build(repo: Repository) -> tuple[Deployment, list[str]]:
    """A project with three tasks and one live deployment row.

    Task ids are fresh uuids because `pz_deployment_tasks.task_id` is a `uuid`
    column — it carries no FK to `pz_tasks` (0027: a task deleted after a build
    shipped must not take the record of what shipped with it), but it is still
    typed, so a "t1" would be rejected by Postgres and accepted by the dict.
    """
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    task_ids = [new_id() for _ in range(3)]
    h.push_tasks(
        repo,
        project.id,
        [
            Task(id=task_id, project_id=project.id, title=f"task {i}", feature_tag=f"T{i + 1}")
            for i, task_id in enumerate(task_ids)
        ],
    )
    row = repo.upsert_deployment(
        Deployment(
            workspace_id=ws.id,
            project_id=project.id,
            provider="platform-r2",
            template_id="static-r2",
            external_key=f"dep-{new_id()[:8]}",
            state="live",
            commit_sha="c0ffee",
        )
    )
    return row, task_ids


def test_a_new_build_is_uncomputed(repo: Repository) -> None:
    row, _ = _build(repo)
    assert row.attribution_state == "uncomputed"
    assert row.attributed_at is None
    assert repo.list_deployment_tasks(row.id) == []


def test_freezing_stores_the_set_in_order_and_stamps_the_row(repo: Repository) -> None:
    row, task_ids = _build(repo)
    ordered = [task_ids[2], task_ids[0], task_ids[1]]

    assert repo.freeze_deployment_tasks(row.id, ordered, utcnow()) is True
    # `position` is what makes this list read the same way twice, and it is
    # written by `unnest(...) with ordinality` on the Postgres side.
    assert repo.list_deployment_tasks(row.id) == ordered

    stored = repo.get_latest_deployment(row.project_id)
    assert stored.attribution_state == "frozen"
    assert stored.attributed_at is not None


def test_a_second_freeze_changes_nothing(repo: Repository) -> None:
    """The whole plan, in one case. A webhook redelivery must not rewrite
    what a reviewer already relied on — and on the production adapter this is
    enforced by a `for update` row lock inside the function, not by anything
    this process does."""
    row, task_ids = _build(repo)
    repo.freeze_deployment_tasks(row.id, task_ids[:2], utcnow())

    assert repo.freeze_deployment_tasks(row.id, [task_ids[2]], utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == task_ids[:2]
    assert repo.get_latest_deployment(row.project_id).attribution_state == "frozen"


def test_an_empty_freeze_is_a_real_answer(repo: Repository) -> None:
    """A build that closed nothing is frozen-and-empty, which is a different
    fact from uncomputed-and-empty — and it must survive a redelivery like
    any other frozen set."""
    row, task_ids = _build(repo)

    assert repo.freeze_deployment_tasks(row.id, [], utcnow()) is True
    assert repo.get_latest_deployment(row.project_id).attribution_state == "frozen"
    assert repo.freeze_deployment_tasks(row.id, task_ids, utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == []


def test_freezing_an_unknown_deployment_writes_nothing(repo: Repository) -> None:
    assert repo.freeze_deployment_tasks(new_id(), [new_id()], utcnow()) is False


def test_clearing_lets_exactly_one_more_freeze_through(repo: Repository) -> None:
    """The correction path. Clearing is the only thing that unfreezes a
    build, and what follows it is an ordinary single freeze — not a licence
    to keep recomputing."""
    row, task_ids = _build(repo)
    repo.freeze_deployment_tasks(row.id, task_ids[:1], utcnow())

    assert repo.clear_deployment_attribution(row.id) is True
    cleared = repo.get_latest_deployment(row.project_id)
    assert cleared.attribution_state == "uncomputed"
    assert cleared.attributed_at is None

    assert repo.freeze_deployment_tasks(row.id, task_ids, utcnow()) is True
    assert repo.list_deployment_tasks(row.id) == task_ids
    # And the door shuts again behind it.
    assert repo.freeze_deployment_tasks(row.id, [], utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == task_ids


def test_clearing_keeps_the_stored_set_until_the_refreeze(repo: Repository) -> None:
    """Clearing must not empty the join table. A recompute that fails between
    the clear and the freeze would otherwise destroy the honest-but-incomplete
    record it was meant to improve."""
    row, task_ids = _build(repo)
    repo.freeze_deployment_tasks(row.id, task_ids[:2], utcnow())
    repo.clear_deployment_attribution(row.id)

    assert repo.list_deployment_tasks(row.id) == task_ids[:2]


def test_clearing_an_unknown_deployment_reports_it(repo: Repository) -> None:
    assert repo.clear_deployment_attribution(new_id()) is False


def test_a_redelivery_upsert_does_not_unfreeze_the_row(repo: Repository) -> None:
    """The back door, on both adapters. Every webhook caller builds a fresh
    `Deployment` from the delivery, so an upsert that wrote the model's
    default would return a frozen row to `uncomputed` — and the next freeze
    would recompute, defeating the guard without ever touching it."""
    row, task_ids = _build(repo)
    repo.freeze_deployment_tasks(row.id, task_ids[:1], utcnow())

    again = repo.upsert_deployment(
        Deployment(
            workspace_id=row.workspace_id,
            project_id=row.project_id,
            provider="platform-r2",
            template_id="static-r2",
            external_key=row.external_key,
            state="live",
            commit_sha="c0ffee",
        )
    )
    assert again.id == row.id
    assert again.attribution_state == "frozen"
    assert repo.freeze_deployment_tasks(row.id, task_ids, utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == task_ids[:1]


def test_sets_are_per_build(repo: Repository) -> None:
    first, task_ids = _build(repo)
    second, other_ids = _build(repo)
    repo.freeze_deployment_tasks(first.id, task_ids[:1], utcnow())
    repo.freeze_deployment_tasks(second.id, other_ids[1:], utcnow())

    assert repo.list_deployment_tasks(first.id) == task_ids[:1]
    assert repo.list_deployment_tasks(second.id) == other_ids[1:]
