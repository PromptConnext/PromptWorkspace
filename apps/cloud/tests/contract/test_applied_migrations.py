"""The migration ledger's filenames (plan 0034 task 1), against both adapters."""

from __future__ import annotations

import pytest

from app.db.repository import InMemoryRepository, Repository

pytestmark = pytest.mark.contract


def test_memory_backend_has_no_ledger(repo: Repository) -> None:
    got = repo.applied_migrations()

    if isinstance(repo, InMemoryRepository):
        assert got is None
    else:
        assert isinstance(got, list)
        assert "0001_pw_schema_migrations_ledger.sql" in got
