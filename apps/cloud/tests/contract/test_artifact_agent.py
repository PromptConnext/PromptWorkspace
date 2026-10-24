"""Agent identity on the closing artifact (plan 0033 spec section 5), against both adapters."""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import ArtifactAgent, ArtifactKind, new_id, utcnow

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_upsert_artifact_merges_agent_once(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    task_id, sha = new_id(), "a" * 40

    def upsert(agent: ArtifactAgent | None):
        return repo.upsert_task_artifact(
            project.id, task_id, "https://x/c", sha, ArtifactKind.code, utcnow(), agent
        )

    first = upsert(None)
    assert first.agent is None

    second = upsert(ArtifactAgent(client="claude-code", model="opus"))
    assert second.id == first.id
    assert second.agent == ArtifactAgent(client="claude-code", model="opus")

    third = upsert(ArtifactAgent(client="cursor"))
    assert third.id == first.id
    assert third.agent == ArtifactAgent(client="claude-code", model="opus")
