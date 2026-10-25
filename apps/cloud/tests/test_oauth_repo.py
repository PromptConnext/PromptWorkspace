"""OAuth store behaviour on the in-memory adapter; the same cases run against
Postgres in tests/contract/test_oauth_store.py."""

import pytest

from app.db.repository import InMemoryRepository

from .contract import test_oauth_store as cases


@pytest.fixture
def repo():
    return InMemoryRepository()


@pytest.mark.parametrize(
    "case",
    [getattr(cases, n) for n in dir(cases) if n.startswith("test_")],
    ids=lambda f: f.__name__,
)
def test_memory(case, repo) -> None:
    case(repo)
