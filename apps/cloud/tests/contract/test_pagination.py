"""Keyset pagination and continuation — plan 0013's contract, both adapters.

`docs/plans/0013-graph-pagination-contract.md` implements finding 3 of the
2026-09-06 cloud codebase review: the two adapters behind
`GET /sync/projects/{id}/graph` paginated differently, and the difference was
invisible from the route. Memory merged every entity type into one
`(updated_at, id)` sequence and applied one `limit` to the page;
`SupabaseRepository` limited each of the six tables independently, filtered the
keyset continuation in Python *after* Postgres had already truncated, and never
set `has_more` or `next_id` — so a client could be handed an empty page of rows
it already held, read that as drained, and lose the rest of the graph silently.

The contract these cases assert is written down once, on
`Repository.get_graph` (app/db/repository.py). Nothing here learns which
adapter it holds: the `repo` fixture (plan 0020, tests/contract/conftest.py)
runs every case against both, and the supabase parameter skips loudly rather
than quietly when no instance is configured.

Ties are seeded by pushing several rows in *one* `upsert_graph` call: both
adapters stamp `updated_at` once per call, so a single push is the only way a
caller can manufacture rows that share a timestamp exactly — which is the
position the review's first failure mode lives at.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.db.repository import Repository
from app.models.schemas import ENTITY_TYPES, ProjectGraph, Requirement, Task, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def _rows(graph: ProjectGraph) -> list[tuple[datetime, str]]:
    """Every row in a page, keyed and ordered the way the contract orders them.

    The page groups rows by entity type, so this is how a client reassembles
    the one global sequence the six lists were cut from.
    """
    out = [
        (row.updated_at, row.id)
        for etype in ENTITY_TYPES
        for row in getattr(graph, etype)
        if row.updated_at is not None
    ]
    return sorted(out)


def _ids(graph: ProjectGraph) -> list[str]:
    return [row[1] for row in _rows(graph)]


def _drain(repo: Repository, project_id: str, limit: int) -> list[ProjectGraph]:
    """Page from the beginning to exhaustion, following the contract's cursor."""
    pages: list[ProjectGraph] = []
    after_ts: datetime | None = None
    after_id: str | None = None
    while True:
        page = repo.get_graph(project_id, limit=limit, after_ts=after_ts, after_id=after_id)
        pages.append(page)
        if not page.has_more:
            return pages
        assert page.next_id is not None, "has_more without a next_id strands the client"
        assert page.cursor is not None
        after_ts, after_id = page.cursor, page.next_id
        assert len(pages) <= 32, "pagination did not terminate"


def test_rows_sharing_one_timestamp_page_exactly_once_in_id_order(repo: Repository) -> None:
    """Equal timestamps spanning a page boundary: ties break by `id`, globally."""
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    ids = sorted(new_id() for _ in range(5))
    h.push_tasks(
        repo,
        proj.id,
        [Task(id=task_id, project_id=proj.id, title=f"T{n}") for n, task_id in enumerate(ids)],
    )

    seeded = repo.get_graph(proj.id)
    assert len({task.updated_at for task in seeded.tasks}) == 1, "one push, one timestamp"

    pages = _drain(repo, proj.id, limit=2)
    assert [len(_rows(page)) for page in pages] == [2, 2, 1]
    assert [task_id for page in pages for task_id in _ids(page)] == ids


def test_one_page_spans_entity_types_and_the_limit_counts_the_page(repo: Repository) -> None:
    """`limit` bounds the page, not each table, and the merge is global."""
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    # Interleaved: one push per row, so every row gets its own timestamp and
    # the global order alternates between the two tables.
    first_req = Requirement(project_id=proj.id, title="R1")
    h.push_requirements(repo, proj.id, [first_req])
    first_task = Task(project_id=proj.id, title="T1")
    h.push_tasks(repo, proj.id, [first_task])
    second_req = Requirement(project_id=proj.id, title="R2")
    h.push_requirements(repo, proj.id, [second_req])
    second_task = Task(project_id=proj.id, title="T2")
    h.push_tasks(repo, proj.id, [second_task])
    third_req = Requirement(project_id=proj.id, title="R3")
    h.push_requirements(repo, proj.id, [third_req])

    expected = _ids(repo.get_graph(proj.id))
    assert len(expected) == 5

    page = repo.get_graph(proj.id, limit=3)
    # Three rows in total — a per-table limit would return three requirements
    # *and* two tasks here, five rows for a limit of three.
    assert len(page.requirements) + len(page.tasks) == 3
    assert _ids(page) == expected[:3]
    assert [req.id for req in page.requirements] == [first_req.id, second_req.id]
    assert [task.id for task in page.tasks] == [first_task.id]
    assert page.has_more is True
    assert (page.cursor, page.next_id) == _rows(page)[-1]

    rest = repo.get_graph(proj.id, limit=3, after_ts=page.cursor, after_id=page.next_id)
    assert _ids(rest) == expected[3:]
    assert rest.has_more is False and rest.next_id is None


def test_a_page_of_already_returned_rows_is_skipped_not_reported_as_drained(
    repo: Repository,
) -> None:
    """The review's first failure mode, reproduced at the keyset position.

    Four tasks tie on one timestamp. After a two-row page, the next
    `limit`-sized slab an *inclusive* `gte(after_ts)` query returns is those
    same two rows — which a post-limit Python filter then drops, yielding an
    empty page that says drained while half the table is unseen.
    """
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    ids = sorted(new_id() for _ in range(4))
    h.push_tasks(
        repo,
        proj.id,
        [Task(id=task_id, project_id=proj.id, title=f"T{n}") for n, task_id in enumerate(ids)],
    )

    first = repo.get_graph(proj.id, limit=2)
    assert [task.id for task in first.tasks] == ids[:2]
    assert first.has_more is True and first.next_id == ids[1]

    second = repo.get_graph(proj.id, limit=2, after_ts=first.cursor, after_id=first.next_id)
    assert [task.id for task in second.tasks] == ids[2:], "the page skipped to unseen rows"
    assert second.has_more is False and second.next_id is None
    assert second.cursor == first.cursor, "the tie's timestamp is still the position"


def test_a_single_table_past_the_limit_reports_more_and_drains_without_gaps(
    repo: Repository,
) -> None:
    """The review's second failure mode: one busy table, everything else sparse.

    Seven tasks tie on one timestamp behind a single earlier requirement, so
    every page but the first is served from one table alone — the case where a
    per-table fetch bounded by exactly `limit` cannot tell a full page from a
    drained one, and `has_more` silently goes False with rows left.
    """
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    sparse = Requirement(project_id=proj.id, title="R1")
    h.push_requirements(repo, proj.id, [sparse])
    ids = sorted(new_id() for _ in range(7))
    h.push_tasks(
        repo,
        proj.id,
        [Task(id=task_id, project_id=proj.id, title=f"T{n}") for n, task_id in enumerate(ids)],
    )

    page = repo.get_graph(proj.id, limit=3)
    assert _ids(page) == [sparse.id, *ids[:2]]
    assert page.has_more is True
    assert page.next_id == ids[1]
    assert page.cursor == _rows(page)[-1][0]

    pages = _drain(repo, proj.id, limit=3)
    assert [task_id for pg in pages for task_id in _ids(pg)] == [sparse.id, *ids]
    assert [len(_rows(pg)) for pg in pages] == [3, 3, 2]


def test_an_exhausted_cursor_is_empty_drained_and_idempotent(repo: Repository) -> None:
    """The end of the walk: empty, `has_more` False, `next_id` None, repeatable."""
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    ids = sorted(new_id() for _ in range(3))
    h.push_tasks(
        repo,
        proj.id,
        [Task(id=task_id, project_id=proj.id, title=f"T{n}") for n, task_id in enumerate(ids)],
    )

    pages = _drain(repo, proj.id, limit=2)
    final = pages[-1]
    assert [task_id for page in pages for task_id in _ids(page)] == ids
    assert final.has_more is False and final.next_id is None

    # The keyset position a drained client holds: the final page's cursor and
    # the last id it saw.
    tail = repo.get_graph(proj.id, limit=2, after_ts=final.cursor, after_id=ids[-1])
    assert _rows(tail) == []
    assert tail.has_more is False and tail.next_id is None
    assert tail.cursor == final.cursor, "an empty page never rewinds the cursor"

    again = repo.get_graph(proj.id, limit=2, after_ts=tail.cursor, after_id=ids[-1])
    assert _rows(again) == []
    assert again.has_more is False and again.next_id is None
    assert again.cursor == tail.cursor
