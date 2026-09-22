"""Which tasks are in this build (ADR 0023 decision 4).

The range is "commits since the previous successful build", not "commits in
this push": a build that lands three pushes' worth of work is one version to
the stakeholder reading the Preview tab, and three entries would be three lies
about what they are looking at.

Frozen, not derived. `pz_deployment_tasks` records the answer at terminal
state so a force-push, a reassignment or a later edit cannot rewrite what
somebody reviewed last Tuesday.
"""

from __future__ import annotations

import logging

from app.integrations.github_auth import resolve_token
from app.models.schemas import ArtifactKind, Deployment, utcnow

logger = logging.getLogger("promptconnext.deploy")

# Terminal states worth freezing. A failed build still names what was in it —
# "the version that did not publish contained these three tasks" is exactly
# what a Tech Lead needs and a stakeholder deserves to be told.
TERMINAL_STATES = frozenset({"live", "failed"})


def _repo_full_name(repo_url: str | None) -> str | None:
    if not repo_url:
        return None
    parts = [p for p in repo_url.rstrip("/").split("/") if p]
    return f"{parts[-2]}/{parts[-1]}" if len(parts) >= 2 else None


def _previous_good_sha(repo, project_id: str, deployment: Deployment) -> str | None:
    for row in repo.list_deployments(project_id, limit=50):
        if row.id == deployment.id:
            continue
        if row.state == "live" and row.commit_sha and row.created_at <= deployment.created_at:
            return row.commit_sha
    return None


async def _commits_in_build(
    app, token: str, full_name: str, base: str | None, head: str
) -> list[str]:
    client = app.state.github_client
    try:
        shas = (
            await client.compare_commits(token, full_name, base, head)
            if base
            else await client.list_commits(token, full_name, head)
        )
    except Exception:  # noqa: BLE001 - attribution must never fail a webhook
        logger.warning("resolving the commit range for %s failed", full_name, exc_info=True)
        shas = []
    # The head commit is always part of its own build; the fallback when the
    # host is unreachable is "at least name the commit we were told about",
    # which is honest and never wrong, only incomplete.
    if head not in shas:
        shas = [*shas, head]
    return shas


async def freeze_build_tasks(app, repo, project, deployment: Deployment) -> list[str]:
    """Resolve and persist this build's task set. Returns the task ids stored.

    Once. Three call sites reach this — app/api/github.py twice and the
    reconciliation sweep — and GitHub redelivers deliveries freely, so the
    early return below is what makes "frozen" true rather than merely stated.
    It sits *before* the GitHub round trip deliberately: a redelivery should
    cost nothing and, more importantly, must not be able to observe a graph
    that has changed since the build shipped.

    The only thing that unfreezes a build is the admin-only reattribute
    endpoint in app/api/deployments.py.
    """
    if deployment.attribution_state == "frozen":
        return repo.list_deployment_tasks(deployment.id)

    if not deployment.commit_sha:
        repo.freeze_deployment_tasks(deployment.id, [], utcnow())
        return repo.list_deployment_tasks(deployment.id)

    full_name = _repo_full_name(project.repo_url)
    resolved = resolve_token(app, repo.get_workspace(project.workspace_id))
    shas: list[str] = [deployment.commit_sha]
    if full_name and resolved is not None:
        token, _config = resolved
        shas = await _commits_in_build(
            app,
            token,
            full_name,
            _previous_good_sha(repo, project.id, deployment),
            deployment.commit_sha,
        )

    in_build = set(shas)
    graph = repo.get_graph(project.id)
    # Ordered by the graph's own task order, so the list reads the same twice.
    attributed = {
        artifact.task_id
        for artifact in graph.artifacts
        if artifact.kind == ArtifactKind.code
        and artifact.commit_sha in in_build
        and artifact.deleted_at is None
    }
    task_ids = [
        task.id for task in graph.tasks if task.id in attributed and task.deleted_at is None
    ]
    repo.freeze_deployment_tasks(deployment.id, task_ids, utcnow())
    # The stored set, not the computed one. A concurrent delivery may have won
    # the race and frozen a different list; that list is the record, and
    # returning ours would hand the caller something no reader will ever see.
    return repo.list_deployment_tasks(deployment.id)
