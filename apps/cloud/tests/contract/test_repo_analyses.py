"""`pz_repo_analyses` on either adapter (plan 0027 M1).

The row carries a nested `snapshot` — a jsonb column in Postgres, a model in
the dict — so the case that matters is the round trip: what goes in as a
`RepoSnapshot` must come back as one, excerpts and stack included, from both
adapters. A memory-only suite would pass against a database where migration
0034 was never applied.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import RepoAnalysis, RepoExcerpt, RepoSnapshot, RepoStack, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def _analysis(project_id: str, workspace_id: str, created_by: str, **overrides) -> RepoAnalysis:
    snapshot = RepoSnapshot(
        commit_sha="c0ffee",
        default_branch="main",
        file_count=3,
        tree_summary="(root) 2 files\nsrc/ 1 file",
        stack=RepoStack(runtime="node", manifests=["package.json"], languages=["TypeScript"]),
        excerpts=[RepoExcerpt(path="README.md", content="# Story app", truncated=False)],
        paths=["README.md", "package.json", "src/index.ts"],
    )
    fields = dict(
        project_id=project_id,
        workspace_id=workspace_id,
        commit_sha="c0ffee",
        snapshot=snapshot,
        created_by=created_by,
    )
    fields.update(overrides)
    return RepoAnalysis(**fields)


def test_no_analysis_reads_as_none(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    assert repo.get_repo_analysis(project.id) is None


def test_an_analysis_round_trips_with_its_snapshot(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)

    repo.upsert_repo_analysis(_analysis(project.id, ws.id, admin))
    stored = repo.get_repo_analysis(project.id)

    assert stored is not None
    assert stored.status == "snapshot_ready"
    assert stored.snapshot.stack.runtime == "node"
    assert stored.snapshot.excerpts[0].content == "# Story app"
    assert stored.snapshot.paths == ["README.md", "package.json", "src/index.ts"]


def test_an_upsert_replaces_the_one_current_analysis(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.upsert_repo_analysis(_analysis(project.id, ws.id, admin))

    second = repo.upsert_repo_analysis(
        first.model_copy(update={"baseline": "# Baseline", "status": "baseline_ready"})
    )
    stored = repo.get_repo_analysis(project.id)

    assert stored.baseline == "# Baseline"
    assert stored.status == "baseline_ready"
    assert second.updated_at >= first.updated_at


def test_analyses_are_per_project(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    one = h.project(repo, ws, admin)
    other = h.project(repo, ws, admin)

    repo.upsert_repo_analysis(_analysis(one.id, ws.id, admin))
    assert repo.get_repo_analysis(other.id) is None


def test_repo_origin_round_trips_and_survives_a_repo_update(repo: Repository) -> None:
    """Migration 0035: recorded at import, kept by an update that names no
    origin, and set by the create path's update."""
    ws, admin = h.workspace(repo)
    imported = repo.create_project(
        ws.id,
        admin,
        "imported",
        repo_url="https://github.com/acme/imported",
        repo_default_branch="main",
        repo_id=int(new_id().replace("-", "")[:12], 16),
        repo_origin="imported",
    )
    assert repo.get_project(imported.id).repo_origin == "imported"
    repo.update_project_repo(
        imported.id, "https://github.com/acme/imported", imported.repo_id, "main"
    )
    assert repo.get_project(imported.id).repo_origin == "imported"

    created = h.project(repo, ws, admin)
    assert repo.get_project(created.id).repo_origin is None
    repo.update_project_repo(
        created.id,
        "https://github.com/acme/created",
        int(new_id().replace("-", "")[:12], 16),
        "main",
        repo_origin="created",
    )
    assert repo.get_project(created.id).repo_origin == "created"
