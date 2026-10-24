"""Repository CRUD for pw_stage_drafts and the provenance defaults added by
migration 0012 (design 2026-10-24-local-agent-brownfield-planning)."""

from __future__ import annotations

from app.db.repository import InMemoryRepository
from app.models.schemas import RepoAnalysis, RepoSnapshot, StageDocument, StageDraft


def _repo_and_project():
    repo = InMemoryRepository()
    ws = repo.create_workspace("W", "alice")
    project = repo.create_project(ws.id, "alice", "P")
    return repo, project


def test_upsert_replaces_the_pending_draft_for_a_stage():
    repo, project = _repo_and_project()
    first = repo.upsert_stage_draft(
        StageDraft(project_id=project.id, workspace_id=project.workspace_id,
                   stage="specify", markdown="# v1", created_by="alice")
    )
    second = repo.upsert_stage_draft(
        StageDraft(project_id=project.id, workspace_id=project.workspace_id,
                   stage="specify", markdown="# v2", created_by="alice",
                   status="rejected", rejection_note="no")
    )
    got = repo.get_stage_draft(project.id, "specify")
    assert got is not None and got.markdown == "# v2"
    assert got.status == "rejected"
    assert len(repo.list_stage_drafts(project.id)) == 1
    assert second.id != first.id


def test_delete_returns_whether_a_draft_existed():
    repo, project = _repo_and_project()
    assert repo.delete_stage_draft(project.id, "plan") is False
    repo.upsert_stage_draft(
        StageDraft(project_id=project.id, workspace_id=project.workspace_id,
                   stage="plan", markdown="# p", created_by="alice")
    )
    assert repo.delete_stage_draft(project.id, "plan") is True
    assert repo.get_stage_draft(project.id, "plan") is None


def test_drafts_are_scoped_per_project():
    repo, project = _repo_and_project()
    repo.upsert_stage_draft(
        StageDraft(project_id=project.id, workspace_id=project.workspace_id,
                   stage="plan", markdown="# p", created_by="alice")
    )
    assert repo.list_stage_drafts("other") == []
    assert repo.get_stage_draft("other", "plan") is None


def test_repo_analysis_defaults_to_cloud_source():
    analysis = RepoAnalysis(
        project_id="p", workspace_id="w", commit_sha="c",
        snapshot=RepoSnapshot(commit_sha="c", default_branch="main"), created_by="a",
    )
    assert analysis.source == "cloud"
    assert analysis.model is None


def test_stage_document_source_defaults_to_none():
    doc = StageDocument(workspace_id="w", project_id="p", stage="plan", created_by="a")
    assert doc.source is None
