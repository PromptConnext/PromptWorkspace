"""Reusable RAG enqueue sweeps, shared by the per-project reindex endpoint
(app/api/assistant.py::reindex_project) and workspace-wide backfill (fired
after a model connection is created — same file, `set_model_connection`).

A sweep has three parts, mirroring the three places content lives:
  1. graph entities (requirements, spec_documents, tasks, pull_requests,
     discussions) — pulled via the same bootstrap `get_graph` reindex used
     to.
  2. the four stage documents (constitution/specify/plan/tasks).
  3. uploaded documents (the PRD) — added in 3ed9bf3 after a project's PRD
     was found permanently unindexed: documents.py enqueues on upload, but
     that only embeds if a model connection resolved *at upload time*. When
     none did, app/rag/queue.py's `_process_job` silently dropped the job
     (no model connection => discarded, not deferred) and there was no way
     back short of re-uploading the file. This module exists so that gap —
     and the workspace-wide version of it, jobs dropped for every project
     because no connection existed *yet* — has exactly one code path to fix,
     not two that can drift apart.

This lives in app/rag/ (not app/api/) so both app/api/assistant.py and
app/api/workspaces.py can import it without either importing the other.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, NamedTuple

from app.db.repository import Repository
from app.deployments.preview_url import repo_full_name_from_url
from app.models.schemas import Project
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES


class ProjectBackfillCount(NamedTuple):
    """One project's contribution to a workspace-wide sweep — lets a caller
    (POST /workspaces/{id}/assistant/reindex) report a per-project breakdown
    without `enqueue_workspace_backfill` itself knowing anything about HTTP
    response shapes."""

    project_id: str
    enqueued: int

# None of these are GraphEntity members of ProjectGraph:
# - pull_requests: GitHub is the source of truth (M11).
# - documents / stage_documents: swept explicitly, they have their own
#   stores rather than living on the graph.
_GRAPH_SKIP_NODE_TYPES = ("pull_requests", "documents", "stage_documents")
_STAGE_NAMES = ("constitution", "specify", "plan", "tasks")


def _iter_backfill_targets(repo: Repository, project: Project) -> Iterator[tuple[str, str]]:
    """Yield (node_type, node_id) for every node a full backfill sweep
    touches — the single enumeration both `enqueue_project_backfill` (which
    turns each into an EmbedJob) and `count_indexable_nodes` (which just
    counts them, for the index-status endpoint) share, so the "what counts
    as indexable" definition can't drift between the two call sites."""
    graph = repo.get_graph(project.id)  # bootstrap pull: live rows only
    for node_type in RAG_NODE_TYPES:
        if node_type in _GRAPH_SKIP_NODE_TYPES:
            continue
        for item in getattr(graph, node_type):
            yield node_type, item.id

    for stage in _STAGE_NAMES:
        stage_doc = repo.get_stage_document(project.id, stage)
        if stage_doc is not None:
            yield "stage_documents", stage_doc.id

    for document in repo.list_documents(project.id):
        yield "documents", document.id


def enqueue_project_backfill(app: Any, repo: Repository, project: Project) -> int:
    """Sweep one project's existing content into the embed queue.

    Enqueueing is cheap and non-blocking — the worker drains in-process —
    so no batching/rate-limiting is applied here.
    """
    enqueued = 0
    for node_type, node_id in _iter_backfill_targets(repo, project):
        enqueue(app, EmbedJob(project.workspace_id, project.id, node_type, node_id))
        enqueued += 1

    # 4. the repository's code (plan 0027 M5). Push-driven indexing only ever
    # sees files a push touched, so a reindex is the one way to reach the rest
    # — most visibly an imported repository's existing code, and any project
    # whose files were pushed while no model connection resolved. One job per
    # repository, expanded into per-file jobs by the worker
    # (app/rag/queue.py::_process_code_tree_job): listing a tree is a GitHub
    # call, and this sweep runs on a request thread. Not part of
    # `_iter_backfill_targets`, because a file is not a graph node and
    # `count_indexable_nodes` counts nodes.
    full_name = repo_full_name_from_url(project.repo_url)
    if full_name is not None and project.lifecycle_status == "repo_created":
        enqueue(
            app,
            EmbedJob(project.workspace_id, project.id, "code_tree", full_name, repo=full_name),
        )
        enqueued += 1
    return enqueued


def count_indexable_nodes(repo: Repository, project: Project) -> int:
    """How many nodes a full backfill (`enqueue_project_backfill`) would
    enqueue right now, without enqueueing anything — used by
    GET /projects/{id}/assistant/index-status so an operator can see the
    target count before deciding whether reindexing is worth it."""
    return sum(1 for _ in _iter_backfill_targets(repo, project))


def enqueue_workspace_backfill(
    app: Any, repo: Repository, workspace_id: str
) -> list[ProjectBackfillCount]:
    """Fan out `enqueue_project_backfill` over every project in a workspace.

    Used after a workspace model connection is (re)configured, so content
    that was unindexable before the connection existed — every job silently
    dropped by app/rag/queue.py's "no model connection" branch — becomes
    retrievable without an admin having to press reindex per project. Also
    used directly by POST /workspaces/{id}/assistant/reindex for a
    deliberate "reindex everything" control (a model swapped in place, an
    embedding dimension change, a failed batch, or plain doubt about
    freshness) — the model-connection path only ever discards this return
    value, so returning a per-project breakdown instead of a bare total
    doesn't disturb that caller.
    """
    return [
        ProjectBackfillCount(project.id, enqueue_project_backfill(app, repo, project))
        for project in repo.list_projects_by_workspace(workspace_id)
    ]
