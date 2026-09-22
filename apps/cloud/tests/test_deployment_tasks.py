"""The frozen build -> task set (ADR 0023 decision 4, plan 0024 M2).

These are the repository-level cases. The freeze is only meaningful against a
real deployment row — the state lives on `pz_deployments`, not on the join
table — so every case here creates one rather than writing task ids against a
bare id string, which is what the pre-freeze version of this file did.
"""

from __future__ import annotations

import pytest

from app.db.repository import InMemoryRepository
from app.models.schemas import Deployment, utcnow


@pytest.fixture
def repo() -> InMemoryRepository:
    return InMemoryRepository()


def _deployment(repo: InMemoryRepository, external_key: str = "dep-1") -> Deployment:
    return repo.upsert_deployment(
        Deployment(
            workspace_id="ws-1",
            project_id="p1",
            provider="platform-r2",
            template_id="static-r2",
            external_key=external_key,
            state="live",
            commit_sha="abc123",
        )
    )


def test_an_unknown_deployment_has_no_tasks(repo):
    assert repo.list_deployment_tasks("nope") == []


def test_a_new_deployment_is_uncomputed(repo):
    # The default matters: it is what tells the Preview tab that an empty
    # task list means "not worked out yet" rather than "closed nothing".
    row = _deployment(repo)
    assert row.attribution_state == "uncomputed"
    assert row.attributed_at is None


def test_freezing_an_unknown_deployment_writes_nothing(repo):
    assert repo.freeze_deployment_tasks("nope", ["t1"], utcnow()) is False
    assert repo.list_deployment_tasks("nope") == []


def test_the_set_round_trips_in_order(repo):
    row = _deployment(repo)
    assert repo.freeze_deployment_tasks(row.id, ["t3", "t1", "t2"], utcnow()) is True
    assert repo.list_deployment_tasks(row.id) == ["t3", "t1", "t2"]


def test_freezing_stamps_the_state_and_the_time(repo):
    row = _deployment(repo)
    now = utcnow()
    repo.freeze_deployment_tasks(row.id, ["t1"], now)

    stored = repo.get_latest_deployment("p1")
    assert stored.attribution_state == "frozen"
    assert stored.attributed_at == now


def test_a_second_freeze_is_a_no_op(repo):
    """The whole point. A redelivery must not rewrite what was reviewed."""
    row = _deployment(repo)
    assert repo.freeze_deployment_tasks(row.id, ["t1", "t2"], utcnow()) is True
    assert repo.freeze_deployment_tasks(row.id, ["t9"], utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == ["t1", "t2"]


def test_an_empty_freeze_still_freezes(repo):
    """A build that genuinely closed nothing is a frozen empty set, not an
    uncomputed one — and it stays empty through a redelivery."""
    row = _deployment(repo)
    assert repo.freeze_deployment_tasks(row.id, [], utcnow()) is True
    assert repo.get_latest_deployment("p1").attribution_state == "frozen"
    assert repo.freeze_deployment_tasks(row.id, ["t1"], utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == []


def test_clearing_lets_the_next_freeze_write(repo):
    row = _deployment(repo)
    repo.freeze_deployment_tasks(row.id, ["t1"], utcnow())

    assert repo.clear_deployment_attribution(row.id) is True
    assert repo.get_latest_deployment("p1").attribution_state == "uncomputed"
    assert repo.get_latest_deployment("p1").attributed_at is None

    assert repo.freeze_deployment_tasks(row.id, ["t1", "t2"], utcnow()) is True
    assert repo.list_deployment_tasks(row.id) == ["t1", "t2"]


def test_clearing_an_unknown_deployment_reports_it(repo):
    assert repo.clear_deployment_attribution("nope") is False


def test_a_redelivery_does_not_reset_the_frozen_flag(repo):
    """The back door: every webhook caller builds a *fresh* Deployment from
    the delivery, so an upsert that took the incoming model's default would
    return a frozen row to 'uncomputed' and let the next freeze recompute."""
    row = _deployment(repo)
    repo.freeze_deployment_tasks(row.id, ["t1"], utcnow())

    again = repo.upsert_deployment(
        Deployment(
            workspace_id="ws-1",
            project_id="p1",
            provider="platform-r2",
            template_id="static-r2",
            external_key="dep-1",
            state="live",
            commit_sha="abc123",
        )
    )
    assert again.id == row.id
    assert again.attribution_state == "frozen"
    assert repo.freeze_deployment_tasks(row.id, ["t9"], utcnow()) is False
    assert repo.list_deployment_tasks(row.id) == ["t1"]


def test_sets_are_per_deployment(repo):
    first = _deployment(repo, "dep-1")
    second = _deployment(repo, "dep-2")
    repo.freeze_deployment_tasks(first.id, ["t1"], utcnow())
    repo.freeze_deployment_tasks(second.id, ["t2"], utcnow())
    assert repo.list_deployment_tasks(first.id) == ["t1"]
    assert repo.list_deployment_tasks(second.id) == ["t2"]
