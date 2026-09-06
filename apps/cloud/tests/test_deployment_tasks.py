"""The frozen build -> task set (ADR 0023 decision 4)."""

from __future__ import annotations

import pytest

from app.db.repository import InMemoryRepository


@pytest.fixture
def repo() -> InMemoryRepository:
    return InMemoryRepository()


def test_an_unknown_deployment_has_no_tasks(repo):
    assert repo.list_deployment_tasks("nope") == []


def test_the_set_round_trips_in_order(repo):
    repo.set_deployment_tasks("d1", ["t3", "t1", "t2"])
    assert repo.list_deployment_tasks("d1") == ["t3", "t1", "t2"]


def test_writing_replaces_rather_than_appends(repo):
    repo.set_deployment_tasks("d1", ["t1", "t2"])
    repo.set_deployment_tasks("d1", ["t9"])
    assert repo.list_deployment_tasks("d1") == ["t9"]


def test_sets_are_per_deployment(repo):
    repo.set_deployment_tasks("d1", ["t1"])
    repo.set_deployment_tasks("d2", ["t2"])
    assert repo.list_deployment_tasks("d1") == ["t1"]
    assert repo.list_deployment_tasks("d2") == ["t2"]
