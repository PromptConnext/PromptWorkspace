"""Field ownership, at first write and under two concurrent writers.

Finding 17 of the review, in two halves.

*First write.* `merge_entity` (app/db/merge.py:65) runs the full ownership gate
on an update (app/db/merge.py:100-119) but takes a first write wholesale — `if
not stored:` (app/db/merge.py:90) copies every incoming field regardless of the
writer's domain and only *filters the version stamps*. So a `pmo` writer that
invents a new task id authors `status` and `acceptance_criteria` on creation,
which the same writer could not do a millisecond later. Closing that gap is plan
0015's M3 ("close the related first-write gap finding 17 names"); this suite
only states the contract and marks the case xfail so the fix is what removes the
marker.

*Concurrent writers.* Both adapters merge outside any transaction:
`SupabaseRepository.upsert_graph` reads (`_fetch_row`,
app/db/supabase_repository.py:633), merges (:635) and upserts (:640) with no
version predicate in between. `tests/test_merge.py` exercises `merge_entity` as
a pure function — `test_concurrent_edits_to_different_fields_both_survive` calls
it twice in sequence — so the interleaving that loses a write is not expressible
there at all. It is expressible here, because `repo` is a repository and not a
function.
"""

from __future__ import annotations

import threading

import pytest

from app.db.repository import Repository
from app.models.schemas import (
    AcceptanceCriterion,
    GraphUpsertRequest,
    Task,
    TaskStatus,
    new_id,
)

from . import _helpers as h

pytestmark = pytest.mark.contract

_ROUNDS = 5


def _write_together(repo: Repository, project_id: str, task_id: str) -> None:
    """Release a pz write of `status` and a pmo write of `assignee` at once.

    The barrier is the closest a caller outside the repository can get to "both
    read before either writes": it removes the head start, and any round trip
    inside the adapter then does the rest.
    """
    start = threading.Barrier(2)
    errors: list[BaseException] = []

    def write(source: str, fields: dict) -> None:
        payload = GraphUpsertRequest(
            tasks=[Task(id=task_id, project_id=project_id, title="T", **fields)],
            source=source,
        )
        try:
            start.wait(timeout=10)
            repo.upsert_graph(project_id, payload, source=source)
        except BaseException as exc:  # noqa: BLE001 - re-raised in the main thread
            errors.append(exc)

    threads = [
        threading.Thread(target=write, args=("pz", {"status": TaskStatus.verified})),
        threading.Thread(target=write, args=("pmo", {"assignee": "jane"})),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    if errors:
        raise errors[0]


@pytest.mark.xfail(
    reason=(
        "finding 17 / plan 0015 M3: merge_entity accepts a first write wholesale, "
        "so a pmo writer authors pz-owned fields on creation. Shared by both "
        "adapters — when plan 0015 closes the gate, delete this marker."
    ),
    strict=True,
)
def test_a_pmo_writer_cannot_author_pz_fields_on_creation(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)

    task = Task(
        project_id=proj.id,
        title="Mirrored from the tracker",
        status=TaskStatus.verified,  # pz-owned
        acceptance_criteria=[AcceptanceCriterion(text="pz-owned")],  # pz-owned
        assignee="jane",  # pmo-owned
        sprint="S-1",  # pmo-owned
    )
    h.push_tasks(repo, proj.id, [task], source="pmo")

    stored = repo.get_task(proj.id, task.id)
    assert stored is not None
    # The gate an update would apply, applied to the insert.
    assert stored.status == TaskStatus.todo
    assert stored.acceptance_criteria == []
    # What the pmo writer does own survives, stamped.
    assert stored.assignee == "jane"
    assert stored.sprint == "S-1"
    versions = stored.field_versions or {}
    assert versions["assignee"]["source"] == "pmo"
    assert "status" not in versions


def test_disjoint_domain_updates_both_survive_sequentially(repo: Repository) -> None:
    """The baseline the interleaved case below is measured against: two domains
    writing different fields of one row, one after the other."""
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    task_id = new_id()
    h.push_tasks(repo, proj.id, [Task(id=task_id, project_id=proj.id, title="T")])

    h.push_tasks(
        repo,
        proj.id,
        [Task(id=task_id, project_id=proj.id, title="T", status=TaskStatus.verified)],
        source="pz",
    )
    h.push_tasks(
        repo,
        proj.id,
        [Task(id=task_id, project_id=proj.id, title="T", assignee="jane", sprint="S-1")],
        source="pmo",
    )

    stored = repo.get_task(proj.id, task_id)
    assert stored is not None
    assert stored.status == TaskStatus.verified
    assert stored.assignee == "jane"
    assert stored.sprint == "S-1"
    versions = stored.field_versions or {}
    assert versions["status"]["source"] == "pz"
    assert versions["assignee"]["source"] == "pmo"


def test_disjoint_domain_updates_both_survive_when_interleaved(
    repo: Repository, request: pytest.FixtureRequest
) -> None:
    """Two writers read the same row, then both write.

    A barrier releases both threads together, so the read-merge-write windows
    overlap; with a network round trip between the read and the write they
    overlap every time. `_ROUNDS` fresh rows because the loss depends on which
    write lands second.
    """
    if repo.backend_name == "supabase":
        # Known divergence, not a flaky test: the merge is a read-modify-write
        # with no version predicate and no transaction, so the second writer's
        # upsert restores the snapshot it read and drops the first writer's
        # field. Non-strict because a scheduling accident can still serialise
        # the two; finding 17's recommendation (atomic field updates, or
        # optimistic concurrency with a retry) is what makes it pass.
        request.node.add_marker(
            pytest.mark.xfail(
                reason=(
                    "finding 17: SupabaseRepository.upsert_graph merges outside a "
                    "transaction with no version predicate, so one of two "
                    "concurrent disjoint-domain writes is lost"
                ),
                strict=False,
            )
        )

    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)

    for _ in range(_ROUNDS):
        task_id = new_id()
        h.push_tasks(repo, proj.id, [Task(id=task_id, project_id=proj.id, title="T")])
        _write_together(repo, proj.id, task_id)

        stored = repo.get_task(proj.id, task_id)
        assert stored is not None
        assert stored.status == TaskStatus.verified, "the pz writer's field was lost"
        assert stored.assignee == "jane", "the pmo writer's field was lost"
        versions = stored.field_versions or {}
        assert versions.get("status", {}).get("source") == "pz"
        assert versions.get("assignee", {}).get("source") == "pmo"
