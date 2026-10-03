"""Projects + Sync API.

The cloud is authoritative for the task graph (ADR 0020): requirements, spec
documents, tasks and their acceptance criteria are authored here and flow
*down*. A local graph in a desktop or editor client is a cache that may be
deleted and rebuilt without loss. The push route below predates that inversion
and remains for the existing engine; a task client writes through the
purpose-built single-field routes instead (assignment, status), never the
full-graph PUT.

Endpoints:
  POST  /projects                                    create a project
  GET   /projects                                    list caller's projects
  GET   /projects/{id}                               fetch one project
  PUT   /sync/projects/{id}/graph                    push a graph delta (upsert)
  GET   /sync/projects/{id}/graph                    pull the graph (?since= cursor)
  PATCH /projects/{id}/tasks/{tid}/assignment        set/clear the pz assignee
  PATCH /projects/{id}/tasks/{tid}/status            set status (+ closing commit)
  GET   /projects/{id}/repository/seed-preview       admin — what the seed would write
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import datetime
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api._guards import (
    _check_graph_write_permissions,
    require_admin,
    require_project,
    require_workspace,
)
from app.db.repository import CrossProjectWrite, Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.plan_profile import StackProfile
from app.deployments.preview_url import (
    platform_preview_url,
    repo_full_name_from_url,
    resolves_before_repo,
)
from app.deployments.registry import PREVIEW_ENVIRONMENT, is_composed_scaffold
from app.deployments.registry import get_template as get_deployment_template
from app.deployments.stack_judge import (
    apply_judgment,
    fingerprint,
    judge,
    judgment_state,
    unanswered,
)
from app.imports.snapshot import CODE_INDEX_MAX_FILES, indexable_code_paths
from app.integrations.deploy_providers import (
    PLATFORM_R2,
    ProviderCredentialError,
    ensure_platform_r2_credential,
    project_fields,
    resolve_provider_credential,
)
from app.integrations.deploy_providers import get_provider as get_deploy_provider
from app.integrations.github import (
    GithubBranchMovedError,
    GithubRefUpdateRejectedError,
    GithubWriteError,
    RepoAlreadyExistsError,
    ensure_hook_events,
    new_webhook_secret,
)
from app.integrations.github_auth import resolve_token
from app.integrations.repo_seed import (
    SeedFile,
    build_deployment_files,
    build_seed_files,
    fit_to_existing_repo,
    proper_prefixes,
    seed_candidate_paths,
)
from app.models.schemas import (
    ENTITY_TYPES,
    ChangesHead,
    CreateRepositoryRequest,
    DeploymentState,
    GraphUpsertRequest,
    GraphUpsertResponse,
    Project,
    ProjectCreate,
    ProjectGraph,
    RelocatedFile,
    RepoWebhook,
    Role,
    SeedPreviewOut,
    Task,
    TaskAssignmentUpdate,
    TaskStatus,
    TaskStatusUpdate,
    new_id,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

# The four Spec Kit stages a project's repo is seeded from (Phase 3,
# app/integrations/repo_seed.py). Order doesn't matter here — build_seed_files
# reads them by name.
_SEED_STAGES = ("constitution", "specify", "plan", "tasks")


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "project"

router = APIRouter(tags=["sync"])
logger = logging.getLogger("promptworkspace.sync")


_REPO_FULL_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


@router.post("/projects", response_model=Project, status_code=201)
async def create_project(
    body: ProjectCreate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    # Only members of the target workspace may create projects in it.
    require_workspace(repo, body.workspace_id, user)

    if body.import_repo_full_name is None:
        return repo.create_project(
            workspace_id=body.workspace_id, created_by=user.id, name=body.name
        )

    # Import path: the user picked a repo from GithubRepoListOut. Everything
    # below runs before any write, same discipline as create_repository.
    full_name = body.import_repo_full_name
    if not _REPO_FULL_NAME_RE.match(full_name):
        raise HTTPException(status_code=422, detail="invalid_repo_full_name")

    workspace = repo.get_workspace(body.workspace_id)
    resolved = resolve_token(request.app, workspace)
    if resolved is None:
        raise HTTPException(status_code=400, detail="github_not_configured")
    token, github_config = resolved
    owner = github_config.get("owner")
    if not owner:
        raise HTTPException(status_code=400, detail="github_not_configured")

    # import_repo_full_name is client-supplied and therefore attacker-
    # controllable by any workspace member; without this check a member could
    # name a repo outside the connected owner and have the platform commit
    # into it at tech-review exit.
    if full_name.split("/")[0].lower() != owner.lower():
        raise HTTPException(status_code=400, detail="repo_owner_out_of_scope")

    github_client = request.app.state.github_client
    try:
        found = await github_client.get_repo(token, full_name)
    except GithubWriteError as exc:
        if getattr(exc, "status_code", None) in (401, 403):
            raise HTTPException(
                status_code=400, detail="github_repo_not_in_token_scope"
            ) from exc
        raise HTTPException(status_code=502, detail="github_unreachable") from exc
    if found is None:
        raise HTTPException(status_code=404, detail="repo_not_found")
    if found.get("empty"):
        raise HTTPException(status_code=400, detail="repo_is_empty")

    # A second project importing the same repo would silently steal the
    # first's webhook binding (pw_repo_webhooks is keyed by repo_full_name) —
    # corrupting deploy state and build attribution for both with no error
    # anywhere downstream. Keyed on GitHub's numeric id, not full_name (a
    # rename/transfer changes the latter without changing the repo), and
    # deliberately unscoped to this workspace — an org-wide token routinely
    # sees repos another workspace already imported (plan 0016 M5).
    if repo.find_project_by_repo_id(found["id"]) is not None:
        raise HTTPException(status_code=409, detail="repo_already_imported")

    return repo.create_project(
        workspace_id=body.workspace_id,
        created_by=user.id,
        name=body.name,
        repo_url=found["html_url"],
        repo_default_branch=found.get("default_branch") or "main",
        repo_id=found["id"],
        repo_origin="imported",
    )


@router.get("/projects", response_model=list[Project])
def list_projects(
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Project]:
    return repo.list_projects(user_id=user.id)


@router.get("/projects/{project_id}", response_model=Project)
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    return require_project(repo, project_id, user)


@router.post("/projects/{project_id}/lifecycle/submit-for-review", response_model=Project)
def submit_for_review(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Planning is done and the project is a Tech Lead's to pick up.

    Originally an explicit "Send to Tech Lead" button, which needed the whole
    graph (requirement + spec + tasks) present before it would fire. The
    Planner now runs this implicitly when a Tech Lead opens the Plan step —
    the step *they* own — so the gate is the specification only: plan and
    tasks are what the Tech Lead is about to produce, and requiring them here
    would mean the transition could never fire at the moment it's needed.

    Still no side effect beyond the status flip
    (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md)."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status != "planning":
        raise HTTPException(status_code=409, detail="not_in_planning")

    graph = repo.get_graph(project_id)
    if not graph.requirements:
        raise HTTPException(status_code=400, detail="planning_incomplete")

    return repo.update_project_lifecycle_status(project_id, "pending_tech_review")


@router.post("/projects/{project_id}/lifecycle/start-tech-review", response_model=Project)
def start_tech_review(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """The design doc calls this transition "automatic on first Tech Lead
    interaction" — the web client may fire it repeatedly as the Tech Lead
    opens the project, so it's deliberately idempotent once in `tech_review`
    rather than erroring on a second call."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status == "tech_review":
        return project
    if project.lifecycle_status != "pending_tech_review":
        raise HTTPException(status_code=409, detail="not_pending_tech_review")
    return repo.update_project_lifecycle_status(project_id, "tech_review")


async def _adopt_repo(
    github_client,
    token: str,
    full_name: str,
    missing_detail: str,
    *,
    identity_ok: Callable[[dict], bool] | None = None,
) -> dict:
    """Read a repository this project is to use rather than creating one.

    Two callers, different identity questions. The retry path (a name
    collision from `create_org_repo`) has no prior identity to check against —
    "GitHub returned a repo for this name" is a lookup key, not proof this
    project made it (plan 0016) — so it passes `identity_ok` and this refuses
    to adopt when that check fails. The import path already knows exactly
    which repository it means, from `project.repo_url` recorded at project
    creation and re-verified against the workspace's current owner just
    above; there is no name to guess from, so it passes no `identity_ok` and
    any repository `get_repo` returns is adopted as-is.

    `missing_detail` is the other difference between the two callers — "the
    name is taken by something else" and "the repository you imported is
    gone" are different problems for whoever reads the error.
    """
    try:
        existing = await github_client.get_repo(token, full_name)
    except GithubWriteError as exc:
        # The repo is there but this token cannot read it. With a fine-grained
        # PAT scoped to "Only select repositories" that is the *expected*
        # answer for a repo outside the grant, so it gets the same actionable
        # error the seeding step raises.
        logger.warning("adopting %s failed: %s", full_name, exc)
        if getattr(exc, "status_code", None) in (401, 403):
            raise HTTPException(status_code=400, detail="github_repo_not_in_token_scope") from exc
        raise HTTPException(status_code=502, detail="github_repo_create_failed") from exc
    if existing is None:
        raise HTTPException(status_code=409, detail=missing_detail) from None
    if identity_ok is not None and not identity_ok(existing):
        # A name collision with a repository this project never created — the
        # case plan 0016 exists for. Refusing to adopt is the whole point:
        # writing secrets and a seed commit into it would be exactly the
        # "someone else's repository" incident the plan describes.
        raise HTTPException(status_code=409, detail="repo_name_collision") from None
    return existing


@router.post("/projects/{project_id}/lifecycle/create-repository", response_model=Project)
async def create_repository(
    project_id: str,
    body: CreateRepositoryRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Creates the GitHub repo at the `tech_review -> repo_created` exit,
    seeds it with AI context derived from the project's stage documents
    (app/integrations/repo_seed.py) and, when a deployment template is
    selected, with that template's scaffold and CI pipeline (ADR 0021).

    Repo creation is external and non-transactional, so ordering is the
    correctness requirement here:

      1. build every file — derived views *and* template scaffold. Pure,
         local, and fails fast on nothing external.
      2. resolve the GitHub token.
      3. resolve the deployment provider credential. A missing one fails
         here, before any external mutation, rather than after a repo exists.
      4. create the repo — or adopt an existing one, either the repository the
         user imported at project creation or one a prior partial attempt left
         behind.
      5. write the Actions secrets and variables. This MUST precede the seed
         commit: that commit fires `on: push` immediately, and a workflow
         that starts before its secrets exist fails its first run for nothing.
      6. reserve the webhook binding, then register the webhook. This MUST
         also precede the seed commit, for a sharper reason: the first
         `deployment_status` can otherwise arrive before the binding row
         exists and be dropped as an unknown repository — losing exactly the
         first deploy's URL.
      7. commit everything as ONE commit (see
         github.py::create_commit_with_files for why not N).
      8. persist `repo_url` and the initial deployment state.
      9. flip the lifecycle last.

    That order means the worst crash window leaves `repo_url` set with status
    still `tech_review`, which a retry recognizes as adoptable; never the
    reverse, which would strand a project as `repo_created` with no repo
    behind it. Steps 5 and 6 add one benign new partial state — secrets and a
    hook on a repo with no workflow — which a retry overwrites.
    """
    project = require_project(repo, project_id, user)
    # Admin-only, like the seed preview that shows what this commits: it
    # writes the admin-owned deployment configuration (the pinned stack
    # judgment) and spends platform-held credentials on the workspace's behalf.
    require_admin(repo, project.workspace_id, user)
    if project.lifecycle_status == "repo_created":
        return project
    if project.lifecycle_status != "tech_review":
        raise HTTPException(status_code=409, detail="not_in_tech_review")

    workspace = repo.get_workspace(project.workspace_id)
    resolved = resolve_token(request.app, workspace)
    if resolved is None:
        raise HTTPException(status_code=400, detail="github_not_configured")
    token, github_config = resolved
    owner = github_config.get("owner")
    if not owner:
        raise HTTPException(status_code=400, detail="github_not_configured")

    # Step 2: assemble seed files before any external mutation. Cheap and
    # pure (app/integrations/repo_seed.py) — fail fast on nothing external.
    stage_docs = _seed_stage_docs(repo, project_id)
    seed_files = build_seed_files(project, stage_docs)

    # Step 3: the deployment provider, still before any external mutation.
    # `deployment` is None for a project with no template selected, which is
    # a fully supported case — the repo is created and seeded exactly as it
    # was before this feature existed.
    try:
        deployment = await _resolve_deployment_provisioning(request.app, project, workspace)
    except ProviderCredentialError as exc:
        raise HTTPException(status_code=400, detail=exc.detail) from exc
    deployment_files: list[SeedFile] = []
    if deployment is not None:
        deployment_files = build_deployment_files(
            project,
            deployment["preview_url"],
            stage_docs.get("plan"),
            _detected_runtime(repo, project),
            await _stack_profile(request.app, repo, project, stage_docs.get("plan")),
        )
    if not project.repo_url:
        seed_files = seed_files + deployment_files

    github_client = request.app.state.github_client

    name = body.name or _slugify(project.name)
    description = f"PromptWorkspace-managed repository for project {project.id}"
    # What an imported repository already holds at the head the seed will
    # parent on; None for a repository this project created, which is seeded
    # exactly as before.
    existing_tree: _ExistingTree | None = None

    if project.repo_url:
        # Step 4, import variant: the project already names a repository the
        # user picked at creation, so adopt it instead of creating one. This is
        # the behaviour the docstring above has always described ("or adopt one
        # from a prior partial attempt") — until now the code could only reach
        # it by colliding on a name it derived itself.
        #
        # `body.name` and `body.private` are ignored here on purpose: the repo
        # exists and already has both.
        imported_full_name = repo_full_name_from_url(project.repo_url)
        if imported_full_name is None:
            raise HTTPException(status_code=409, detail="repo_url_unrecognized")
        # Re-check the owner even though creation checked it: an admin may have
        # reconnected the workspace to a different owner in between, and the
        # PAT we are about to write secrets with belongs to the *current* one.
        if imported_full_name.split("/")[0].lower() != owner.lower():
            raise HTTPException(status_code=400, detail="repo_owner_out_of_scope")
        created = await _adopt_repo(
            github_client, token, imported_full_name, "imported_repo_not_found"
        )
        # Plan 0027 M4: the repository has content of its own, and the seed
        # must not overwrite any of it. Read from the live tree, not the
        # stored analysis — a file pushed since then is just as much the
        # team's — and still before any mutation, so a workflow conflict
        # refuses with nothing written.
        existing_tree = await _existing_tree(
            github_client,
            token,
            created,
            project,
            description,
            seed_candidate_paths(seed_files, deployment_files),
        )
        if existing_tree is None:
            seed_files = seed_files + deployment_files
        else:
            seed_plan = fit_to_existing_repo(
                seed_files, deployment_files, existing_tree.entries, existing_tree.dirs
            )
            if seed_plan.conflicts:
                raise HTTPException(status_code=409, detail="deploy_workflow_conflict")
            seed_files = seed_plan.files
    else:
        try:
            created = await github_client.create_org_repo(
                token,
                owner,
                name,
                description,
                body.private,
                github_config.get("owner_type", "Organization"),
            )
        except RepoAlreadyExistsError:
            # Retry path after a mid-flight failure: adopt the repo we
            # (likely) created on a previous attempt — but only if the
            # evidence actually supports "likely" (plan 0016). Two windows:
            # repo_id was already persisted on an earlier successful retry
            # (the numeric id is authoritative, even across a rename); or
            # this is the very first retry, before step 8 ever ran, in which
            # case the only signal available is the description this project
            # would have written verbatim at creation.
            def _is_our_repo(existing: dict) -> bool:
                if project.repo_id is not None:
                    return existing.get("id") == project.repo_id
                return existing.get("description") == description

            created = await _adopt_repo(
                github_client,
                token,
                f"{owner}/{name}",
                "repo_name_taken",
                identity_ok=_is_our_repo,
            )
        except GithubWriteError as exc:
            raise HTTPException(status_code=502, detail="github_repo_create_failed") from exc

    full_name = created["full_name"]
    default_branch = created.get("default_branch") or "main"
    # Server-side provenance (plan 0027): recorded on the create path only.
    # An imported project already carries "imported" from POST /projects, and
    # a retry through the adopt branch must not relabel either kind.
    repo_origin = None if project.repo_url else "created"

    # Step 5: Actions secrets and variables, BEFORE the commit that starts
    # the first workflow run. Not best-effort — a pipeline seeded without its
    # credentials is a repo whose every run fails, which is worse than a
    # transition that stopped and can be retried.
    if deployment is not None:
        try:
            for name, value in deployment["secrets"].items():
                await github_client.put_actions_secret(token, full_name, name, value)
            for name, value in deployment["variables"].items():
                await github_client.put_actions_variable(token, full_name, name, value)
        except GithubWriteError as exc:
            logger.warning("writing Actions secrets for %s failed: %s", full_name, exc)
            # A fine-grained PAT that can create a repo may still lack
            # Secrets: write — a permission this feature added and that no
            # existing workspace's token carries. There is no introspection
            # endpoint to catch it earlier, so it has its own code rather
            # than hiding inside the generic scope error.
            if getattr(exc, "status_code", None) in (403, 404):
                raise HTTPException(
                    status_code=400, detail="github_secrets_not_in_token_scope"
                ) from exc
            raise HTTPException(status_code=502, detail="github_secrets_failed") from exc

    # Register this repo's webhook with its own secret, so PR/push indexing
    # starts working without any further setup. Skipped entirely when
    # PUBLIC_API_URL is unset (local dev, where GitHub cannot reach this
    # service anyway).
    #
    # Step 6, and it runs BEFORE the seed commit on purpose: that commit
    # triggers the first deploy, and a delivery arriving before the binding
    # row exists is dropped as an unknown repository — silently losing the
    # first deploy's URL, which is the one the Tech Lead is watching for.
    public_api_url = request.app.state.settings.public_api_url
    if public_api_url:
        callback_url = f"{public_api_url.rstrip('/')}/api/webhooks/github"
        # Persist a first-writer-wins binding *before* registering remotely.
        # It begins pending and is confirmed only after GitHub accepts it.
        # The durable claim on a pending row prevents a second request from
        # treating the first request's provisional secret as known-good.
        service_repo = request.app.state.repository
        registration_owner = new_id()
        try:
            proposed_binding = RepoWebhook(
                repo_full_name=full_name,
                project_id=project_id,
                workspace_id=project.workspace_id,
                secret_ref=request.app.state.secret_store.encrypt(new_webhook_secret()),
                registration_state="pending",
                registration_owner=registration_owner,
            )
            binding, reservation_created = service_repo.create_repo_webhook_if_absent(
                proposed_binding
            )
        except Exception as exc:  # noqa: BLE001 - repository failure maps to a retryable response
            logger.exception("storing webhook binding for %s failed", full_name)
            raise HTTPException(status_code=502, detail="webhook_binding_failed") from exc

        if binding.project_id != project_id or binding.workspace_id != project.workspace_id:
            raise HTTPException(status_code=409, detail="repo_webhook_already_bound")

        try:
            secret = request.app.state.secret_store.decrypt(binding.secret_ref)
        except Exception:  # noqa: BLE001 - never replace a corrupt persisted secret
            logger.warning("webhook binding for %s has an unusable secret", full_name)
            raise HTTPException(status_code=409, detail="webhook_secret_repair_required") from None

        pending_claimed = reservation_created
        if binding.registration_state == "pending" and not reservation_created:
            try:
                pending_claimed = service_repo.claim_pending_repo_webhook(
                    binding, registration_owner
                )
            except Exception as exc:  # noqa: BLE001 - repository failure is retryable
                logger.exception("claiming webhook registration for %s failed", full_name)
                raise HTTPException(status_code=502, detail="webhook_binding_failed") from exc
            if not pending_claimed:
                # Another request owns the only safe registration attempt.
                # It will either confirm this binding or leave a repairable
                # pending row; this request must not contact GitHub meanwhile.
                raise HTTPException(status_code=409, detail="webhook_registration_in_progress")

        try:
            registered_new_hook = await github_client.create_repo_webhook(
                token, full_name, callback_url, secret
            )
            if not registered_new_hook and binding.registration_state == "pending":
                # A pending binding has not yet proved that its secret is the
                # remote secret. A duplicate can therefore be a legacy hook.
                # Only its creator removes it: a later request may be retrying
                # an earlier uncertain result and must leave the evidence for
                # explicit repair rather than racing its cleanup.
                if reservation_created:
                    if not service_repo.delete_repo_webhook_if_matches(
                        binding, registration_owner
                    ):
                        raise RuntimeError("provisional webhook binding changed before cleanup")
                elif not service_repo.release_pending_repo_webhook(binding, registration_owner):
                    raise RuntimeError("pending webhook registration claim changed before release")
                repo.update_project_repo(
                    project_id,
                    created["html_url"],
                    created["id"],
                    default_branch,
                    repo_origin=repo_origin,
                )
                raise HTTPException(status_code=409, detail="webhook_secret_repair_required")

            if binding.registration_state == "pending":
                if not service_repo.confirm_pending_repo_webhook(binding, registration_owner):
                    raise RuntimeError("webhook binding changed before confirmation")

            # A locally known duplicate may still need the event list widened
            # after an older registration. That update never changes config or
            # the signing secret, so it is safe for ordinary retries.
            await ensure_hook_events(github_client, token, full_name, callback_url)
        except HTTPException:
            raise
        except GithubWriteError as exc:
            # The binding is deliberately left in place. A retry must reuse
            # the same secret: GitHub may have accepted the first request even
            # though its response was lost, and changing the local secret
            # would make future deliveries unverifiable. Stop before the seed
            # commit and lifecycle transition so this remains an explicitly
            # retryable tech-review project.
            if binding.registration_state == "pending" and pending_claimed:
                try:
                    service_repo.release_pending_repo_webhook(binding, registration_owner)
                except Exception:  # noqa: BLE001 - preserve the binding even if unlock fails
                    logger.exception("releasing webhook registration for %s failed", full_name)
            logger.warning("webhook registration failed for %s: %s", full_name, exc)
            raise HTTPException(status_code=502, detail="github_webhook_failed") from exc
        except Exception as exc:  # noqa: BLE001 - preserve the recovery state on cleanup errors
            if binding.registration_state == "pending" and pending_claimed:
                try:
                    service_repo.release_pending_repo_webhook(binding, registration_owner)
                except Exception:  # noqa: BLE001 - original error remains the useful response
                    logger.exception("releasing webhook registration for %s failed", full_name)
            logger.exception("cleaning up webhook binding for %s failed", full_name)
            raise HTTPException(status_code=502, detail="webhook_binding_cleanup_failed") from exc

    # Step 7: one commit, not one per file. See
    # github.py::create_commit_with_files — this is what collapses the
    # partial-seed window to a single atomic ref update, and it is also what
    # keeps a forty-file scaffold inside one HTTP request.
    #
    # An imported repository that already carries every file this seed would
    # write (docs/promptworkspace/* left by an earlier import) gets no commit at all:
    # there is nothing to add, and an empty seed is not an error.
    #
    # An imported repository's commit is pinned to the head its tree was
    # checked at: a push landing in between could add a file the seed's tree
    # would then replace, so a moved branch refuses rather than committing.
    try:
        if seed_files:
            await github_client.create_commit_with_files(
                token,
                full_name,
                default_branch,
                seed_files,
                "chore: seed project context from PromptWorkspace",
                expected_base_sha=existing_tree.head_sha if existing_tree is not None else None,
            )
    except GithubBranchMovedError as exc:
        logger.warning("seeding %s refused: %s", full_name, exc)
        raise HTTPException(status_code=409, detail="repo_moved_during_seed") from exc
    except GithubRefUpdateRejectedError as exc:
        # Branch protection or a ruleset on the default branch: every retry
        # would be refused the same way, so this must not read as the
        # transient `repo_moved_during_seed`. The admin lifts the rule (or
        # exempts the token's user) and retries.
        logger.warning("seeding %s refused by the branch's rules: %s", full_name, exc)
        raise HTTPException(status_code=409, detail="default_branch_protected") from exc
    except GithubWriteError as exc:
        # Do NOT advance the lifecycle — an unseeded repo must leave
        # repo_url unset so a retry re-enters at repo creation and adopts.
        #
        # Log the underlying GitHub response: the client puts status + body in
        # the exception message, and without this the operator sees only the
        # opaque `github_seed_failed` the browser shows.
        logger.warning("seeding %s failed: %s", full_name, exc)
        # A 403/404 writing into a repo GitHub just told us it created is not
        # a transient fault — it means the token cannot see that repo. With a
        # fine-grained PAT scoped to "Only select repositories", every new
        # repo lands outside the grant, so "try again" would loop forever.
        if getattr(exc, "status_code", None) in (403, 404):
            raise HTTPException(status_code=400, detail="github_repo_not_in_token_scope") from exc
        raise HTTPException(status_code=502, detail="github_seed_failed") from exc

    # Step 8: repo-write first, lifecycle flip last — see docstring.
    repo.update_project_repo(
        project_id, created["html_url"], created["id"], default_branch, repo_origin=repo_origin
    )
    if deployment is not None:
        template = deployment["template"]
        # Resolved a second time for a template whose URL is derived from the
        # repository (GitHub Pages): the first resolution ran before the repo
        # existed and could only return None. Every other template's value is
        # unchanged by this call.
        preview_url = deployment["preview_url"] or platform_preview_url(
            template,
            project=project,
            settings=request.app.state.settings,
            repo_full_name=full_name,
        )
        # "awaiting_first_deploy", not "building": the commit above has landed
        # but GitHub has not told us a run started, and every state this
        # feature shows is one the server was actually told about.
        repo.update_project_deployment_state(
            project_id,
            DeploymentState(
                template_id=template.id,
                provider=template.provider,
                state="awaiting_first_deploy",
                url=preview_url,
            ),
        )
    updated = repo.update_project_lifecycle_status(project_id, "repo_created")
    if existing_tree is not None:
        _enqueue_initial_code_index(
            request.app, repo, project, full_name, existing_tree.head_sha, existing_tree.blobs
        )
    return updated


def _enqueue_initial_code_index(
    app, repo: Repository, project: Project, full_name: str, head_sha: str, paths: list[str]
) -> int:
    """A repository created here starts with a handful of seeded files and is
    indexed push by push from then on. An imported one arrives with its whole
    history already written, and nothing would ever push most of it again —
    so it gets one initial sweep at `repo_created` (plan 0027 M5), capped at
    CODE_INDEX_MAX_FILES so a monorepo cannot flood the embed queue.

    One `code_file` job per indexable path, pinned to the pre-seed head —
    the same job the push webhook enqueues (app/api/github.py::_handle_push),
    so the worker path is shared rather than parallel. Skipped outright for a
    workspace with no model connection, which is the condition the worker
    itself would drop every one of these jobs for."""
    if repo.get_model_connection(project.workspace_id) is None:
        return 0
    selected = indexable_code_paths(paths, CODE_INDEX_MAX_FILES)
    for path in selected:
        enqueue(
            app,
            EmbedJob(
                project.workspace_id,
                project.id,
                "code_file",
                node_id=f"{full_name}:{path}",
                repo=full_name,
                path=path,
                sha=head_sha,
            ),
        )
    return len(selected)


def _seed_stage_docs(repo: Repository, project_id: str) -> dict[str, str | None]:
    return {
        stage: (doc.content if doc else None)
        for stage, doc in ((s, repo.get_stage_document(project_id, s)) for s in _SEED_STAGES)
    }


def _detected_runtime(repo: Repository, project: Project) -> str | None:
    """What an imported repository's manifests say it is written in, from its
    stored analysis (plan 0027) — None for every other project."""
    if not project.repo_url:
        return None
    analysis = repo.get_repo_analysis(project.id)
    return analysis.snapshot.stack.runtime if analysis is not None else None


async def _stack_profile(
    app, repo: Repository, project: Project, plan_text: str | None
) -> StackProfile | None:
    """The composed scaffold's selection from a pinned TypeSafe judgment
    (app/deployments/stack_judge.py), or None to let `build_deployment_files`
    run its keyword scan as it always has.

    Asks the model only when no stored judgment answers the current plan (and,
    for an imported repository, its analysed manifests), and stores the answer
    before returning it — so the seed preview pins what `create_repository`
    will select, and a retry after a partial failure selects it again. Both
    callers run before the project is frozen at `repo_created`.
    """
    config = project.deployment_config
    if config is None or not is_composed_scaffold(config.template_id):
        return None
    analysis = repo.get_repo_analysis(project.id) if project.repo_url else None
    snapshot = analysis.snapshot if analysis is not None else None
    state = judgment_state(plan_text, snapshot)
    if state is None:
        return None
    input_sha256 = fingerprint(state, plan_text)
    judgment = config.stack_judgment
    if judgment is None or judgment.input_sha256 != input_sha256:
        client = getattr(app.state, "typesafe_client", None)
        if client is None:
            return None
        # A failed call is pinned too (as "keywords decide"), so a preview
        # that fell back and a seed whose call succeeds cannot disagree.
        judgment = await judge(client, state, input_sha256) or unanswered(input_sha256)
        # The call can take seconds. Write back only onto the configuration
        # it was asked for: an admin PATCH in the meantime wins, and this
        # request uses the judgment without pinning it.
        current = repo.get_project(project.id)
        stored = current.deployment_config if current is not None else None
        if (
            stored is not None
            and stored.template_id == config.template_id
            and stored.provider_values == config.provider_values
        ):
            repo.update_project_deployment_config(
                project.id, stored.model_copy(update={"stack_judgment": judgment})
            )
    detected = snapshot.stack.runtime if snapshot is not None else None
    return apply_judgment(judgment, plan_text, detected)


class _ExistingTree(NamedTuple):
    """An adopted repository's content at the head the seed will parent on."""

    head_sha: str
    # Readable files, for the initial code index.
    blobs: list[str]
    # Every non-directory entry (files, symlinks, submodule gitlinks) and
    # every directory — what `fit_to_existing_repo` must not write over.
    entries: frozenset[str]
    dirs: frozenset[str]


def _platform_created(project: Project, repo_row: dict, own_description: str) -> bool:
    """Whether an adopted repository is one this project created itself —
    the crash-window retry `create_repository`'s docstring describes, where
    `repo_url` was recorded before the seed commit landed.

    Decided by `project.repo_origin`, which only the server can write: the
    API never accepts it from a client, and since migration 0036 a member's
    own JWT cannot write `pw_projects` through PostgREST either (before it,
    `pw_projects_rw` tested membership alone and any member could set it —
    so 0036 must be applied for this check to hold on Supabase). The
    repository description is a secondary check, never sufficient alone —
    anyone with admin on an imported repository can set it to the string
    this project would write, and the prize for doing so is a seed that
    overwrites the repository's own README and AGENTS.md. A project with no
    recorded origin (one that predates migration 0035) is treated as
    imported: the relocated seed is the one that cannot destroy anything.
    """
    return project.repo_origin == "created" and repo_row.get("description") == own_description


async def _existing_tree(
    github_client,
    token: str,
    repo_row: dict,
    project: Project,
    own_description: str,
    candidates: set[str],
) -> _ExistingTree | None:
    """What an adopted repository's default branch holds, or None when the
    repository is one this project created itself (`_platform_created`) —
    that one keeps the full, unrelocated seed it always had.

    GitHub truncates a recursive listing of a very large repository rather
    than failing it, and an incomplete listing here would let the seed
    overwrite a file it never saw. So when the listing is truncated, every
    directory on the way to a path the seed could write (`candidates`) is
    listed on its own, non-recursively: that yields every entry a candidate
    could collide with — exactly, case-insensitively or through a prefix —
    whatever the size of the rest of the repository.
    """
    if _platform_created(project, repo_row, own_description):
        return None
    full_name = repo_row["full_name"]
    branch = repo_row.get("default_branch") or "main"
    try:
        head_sha = await github_client.get_branch_head(token, full_name, branch)
        listing, truncated = await github_client.get_tree_entries(token, full_name, head_sha)
        entries = {e["path"] for e in listing if e["type"] != "tree"}
        dirs = {e["path"] for e in listing if e["type"] == "tree"}
        blobs = [e["path"] for e in listing if e["type"] == "blob"]
        if truncated:
            wanted = {prefix.lower() for path in candidates for prefix in proper_prefixes(path)}
            pending = [("", head_sha)]
            while pending:
                directory, tree_sha = pending.pop()
                children, children_truncated = await github_client.get_tree_entries(
                    token, full_name, tree_sha, recursive=False
                )
                if children_truncated:
                    # One directory too large for GitHub to list at all: there
                    # is no complete answer to "is this path free", so no seed.
                    raise HTTPException(status_code=409, detail="repo_tree_too_large")
                for child in children:
                    path = f"{directory}/{child['path']}" if directory else child["path"]
                    if child["type"] == "tree":
                        dirs.add(path)
                        if path.lower() in wanted:
                            pending.append((path, child["sha"]))
                    else:
                        entries.add(path)
    except GithubWriteError as exc:
        logger.warning("reading the tree of %s failed: %s", full_name, exc)
        if getattr(exc, "status_code", None) in (401, 403):
            raise HTTPException(status_code=400, detail="github_repo_not_in_token_scope") from exc
        raise HTTPException(status_code=502, detail="github_unreachable") from exc
    return _ExistingTree(head_sha, blobs, frozenset(entries), frozenset(dirs))


@router.get("/projects/{project_id}/repository/seed-preview", response_model=SeedPreviewOut)
async def seed_preview(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> SeedPreviewOut:
    """What `create_repository` would commit, without committing it (plan 0027
    M4) — so the Tech Lead consents to a list of paths, not to a promise.

    Built by the same builders and the same `fit_to_existing_repo` the real
    seed uses, against the same live tree. The one thing done differently is
    the deployment provider: resolving it can mint a platform credential,
    which a preview must never do, so the template's files are built without
    a preview URL — that changes one document's text, never a path.
    """
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="repo_already_created")

    stage_docs = _seed_stage_docs(repo, project_id)
    seed_files = build_seed_files(project, stage_docs)
    deployment_files = build_deployment_files(
        project,
        None,
        stage_docs.get("plan"),
        _detected_runtime(repo, project),
        await _stack_profile(request.app, repo, project, stage_docs.get("plan")),
    )
    if not project.repo_url:
        return SeedPreviewOut(write=[f.path for f in seed_files + deployment_files])

    workspace = repo.get_workspace(project.workspace_id)
    resolved = resolve_token(request.app, workspace)
    if resolved is None:
        raise HTTPException(status_code=400, detail="github_not_configured")
    token, github_config = resolved
    owner = github_config.get("owner")
    if not owner:
        raise HTTPException(status_code=400, detail="github_not_configured")
    imported_full_name = repo_full_name_from_url(project.repo_url)
    if imported_full_name is None:
        raise HTTPException(status_code=409, detail="repo_url_unrecognized")
    if imported_full_name.split("/")[0].lower() != owner.lower():
        raise HTTPException(status_code=400, detail="repo_owner_out_of_scope")

    github_client = request.app.state.github_client
    adopted = await _adopt_repo(github_client, token, imported_full_name, "imported_repo_not_found")
    description = f"PromptWorkspace-managed repository for project {project.id}"
    existing_tree = await _existing_tree(
        github_client,
        token,
        adopted,
        project,
        description,
        seed_candidate_paths(seed_files, deployment_files),
    )
    if existing_tree is None:
        return SeedPreviewOut(write=[f.path for f in seed_files + deployment_files])

    plan = fit_to_existing_repo(
        seed_files, deployment_files, existing_tree.entries, existing_tree.dirs
    )
    return SeedPreviewOut(
        write=[f.path for f in plan.files],
        relocated=[RelocatedFile(from_path=a, to_path=b) for a, b in plan.relocated],
        skipped=plan.skipped,
        conflicts=plan.conflicts,
    )


async def _resolve_deployment_provisioning(app, project: Project, workspace) -> dict | None:
    """Everything the seeded pipeline needs, resolved before any external
    mutation: the template, the Actions secrets and variables, and the
    preview URL.

    Returns None when no template is selected — the supported "just a repo"
    case. Raises `ProviderCredentialError` when a template *is* selected but
    its provider cannot supply a credential, so `create_repository` can fail
    with a 400 while nothing has been created yet.

    The secret/variable split is the template's to declare (SecretSpec and
    VarSpec in app/deployments/registry.py) and the provider's to fill, which
    is what lets a new template land without touching this function.
    """
    config = project.deployment_config
    if config is None:
        return None
    template = get_deployment_template(config.template_id)
    if template is None:
        return None

    settings = app.state.settings
    provider = get_deploy_provider(template.provider)
    credential: dict = {}

    if template.provider == PLATFORM_R2:
        credential = await ensure_platform_r2_credential(app, workspace)
    elif provider is not None and provider.credential_owner == "host":
        # Nothing to resolve: the git host hands the workflow its own
        # ephemeral token at run time, so this template seeds no secret and
        # there is no workspace connection that could be missing.
        pass
    else:
        resolved = resolve_provider_credential(app, workspace, template.provider)
        if resolved is None:
            raise ProviderCredentialError("deployment_provider_not_configured")
        token, provider_config = resolved

        # The project's own provider identifiers (its Fly app, its Vercel
        # project) layered over the workspace credential, so everything below
        # resolves `provider:<key>` without caring which half a value came
        # from. Restricted to keys the provider declares `scope="project"`:
        # this dict decides what is written into repository secrets, so an
        # unfiltered merge would let a stored project value shadow `token`.
        declared = project_fields(provider) if provider else ()
        project_values = {
            f.name: (config.provider_values or {}).get(f.name, "").strip() for f in declared
        }
        missing = [name for name, value in project_values.items() if not value]
        if missing:
            # Its own code rather than `deployment_provider_incomplete`: this
            # one is fixed on the project's deployment template, by a Tech
            # Lead, not by reconnecting the workspace credential.
            raise ProviderCredentialError("deployment_project_values_missing")

        credential = {**provider_config, **project_values, "token": token}

    # Resolved through one declarative table rather than by calling one
    # provider's URL helper, so every platform-URL template gets the value the
    # webhook will later pin its report against. See
    # app/deployments/preview_url.py.
    preview_url = platform_preview_url(template, project=project, settings=settings)

    # A platform-computed URL is the one thing the workflow cannot derive
    # for itself, and reporting a deploy with no URL would leave a business
    # user a "live" preview they cannot open. Its own code, so an operator
    # sees which setting is missing rather than a generic "incomplete".
    # Skipped for a URL that is derived from the repository, which does not
    # exist yet at this point — `create_repository` resolves that one after it
    # has created the repo.
    if template.url_kind == "platform" and not preview_url and resolves_before_repo(template):
        raise ProviderCredentialError("deployment_preview_url_not_configured")

    secrets_out: dict[str, str] = {}
    for spec in template.required_secrets:
        # An unnamed `from_provider` means the credential's primary secret;
        # a named one selects a field. Missing values are refused rather than
        # written empty: an empty secret produces a workflow that fails at
        # runtime with no explanation.
        key = spec.from_provider or _default_secret_key(spec.name)
        value = credential.get(key)
        if not value:
            raise ProviderCredentialError("deployment_provider_incomplete")
        secrets_out[spec.name] = value

    vars_out: dict[str, str] = {}
    for spec in template.required_vars:
        value = _resolve_var(spec.source, project, template, credential, settings, preview_url)
        if value is None:
            raise ProviderCredentialError("deployment_provider_incomplete")
        vars_out[spec.name] = value

    return {
        "template": template,
        "secrets": secrets_out,
        "variables": vars_out,
        "preview_url": preview_url,
    }


def _default_secret_key(secret_name: str) -> str:
    """`PROMPTWORKSPACE_R2_ACCESS_KEY_ID` -> `access_key_id`. Lets a template name the
    Actions secret its workflow reads without the provider having to know
    that name, and vice versa."""
    return secret_name.removeprefix("PROMPTWORKSPACE_").lower().removeprefix("r2_")


def _resolve_var(source, project, template, credential, settings, preview_url) -> str | None:
    if source.startswith("provider:"):
        return credential.get(source.split(":", 1)[1])
    if source.startswith("literal:"):
        return source.split(":", 1)[1]
    return {
        "project_id": project.id,
        "template_id": template.id,
        "environment": PREVIEW_ENVIRONMENT,
        "web_origin": settings.web_app_url,
        "preview_url": preview_url,
    }.get(source)


@router.patch("/projects/{project_id}/tasks/{task_id}/assignment", response_model=Task)
def assign_task(
    project_id: str,
    task_id: str,
    body: TaskAssignmentUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Task:
    project = require_project(repo, project_id, user)  # membership-gated
    task = repo.get_task(project_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    caller_role = repo.get_membership(project.workspace_id, user.id)
    target = body.assigned_user_id

    # Permission: admins assign/clear anyone; a member may only assign a task
    # to themselves or clear a task currently assigned to themselves.
    if caller_role != Role.admin:
        self_assign = target == user.id and target is not None
        self_unassign = target is None and task.assigned_user_id == user.id
        if not (self_assign or self_unassign):
            raise HTTPException(status_code=403, detail="assignment_forbidden")

    # Target must be a current member of the task's workspace (null = unassign).
    if target is not None:
        member_ids = {m.user_id for m in repo.list_members(project.workspace_id)}
        if target not in member_ids:
            raise HTTPException(status_code=400, detail="assignee_not_a_member")

    return repo.assign_task(project_id, task_id, target, utcnow())


@router.patch("/projects/{project_id}/tasks/{task_id}/status", response_model=Task)
def set_task_status(
    project_id: str,
    task_id: str,
    body: TaskStatusUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Task:
    """Close the loop from wherever a developer works (ADR 0020 decision 2).

    Deliberately not `PUT /sync/projects/{id}/graph`: that route takes a full
    `Task`, whose `title` is *shared* authority (a naive "mark done" would
    overwrite a tracker's rename) and whose `acceptance_criteria` is a pw-owned
    list a `model_dump` cannot distinguish from "cleared". Same argument ADR
    0018 made for assignment, same answer.
    """
    project = require_project(repo, project_id, user)  # membership-gated
    task = repo.get_task(project_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    caller_role = repo.get_membership(project.workspace_id, user.id)

    # Permission mirrors assign_task's shape — admins act on any task, a member
    # acts only on their own. An unassigned task is therefore forbidden to a
    # member by design: without that, a commit mentioning "T012" would close a
    # task nobody claimed, or somebody else's. Clients self-assign first
    # (members may already do that) and then call this.
    if caller_role != Role.admin:
        if task.assigned_user_id != user.id:
            raise HTTPException(status_code=403, detail="status_forbidden")
        # `verified` is a review state, and the implemented/verified distinction
        # is exactly what ADR 0020 flags as the lossy edge. A developer reports
        # implementation; someone else verifies it.
        if body.status == TaskStatus.verified:
            raise HTTPException(status_code=403, detail="verified_requires_admin")

    now = utcnow()
    # Evidence first, so a task is never closed with its artifact missing.
    if body.artifact is not None:
        repo.upsert_task_artifact(
            project_id,
            task_id,
            body.artifact.uri,
            body.artifact.commit_sha,
            body.artifact.kind,
            now,
        )
    return repo.set_task_status(project_id, task_id, body.status, now)


@router.put("/sync/projects/{project_id}/graph", response_model=GraphUpsertResponse)
def push_graph(
    project_id: str,
    payload: GraphUpsertRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GraphUpsertResponse:
    """A bounded compatibility endpoint (plan 0015 M1), pending plan 0012 M4.

    ADR 0020 made the cloud authoritative for the task graph, which leaves this
    route as the one door that writes every entity at once. It is kept, not
    retired, because it still has exactly one real caller: the engine's manual
    push (`POST /engine/projects/:id/cloud-sync` → `pushProjectSnapshot`,
    apps/engine/src/routes/cloud.ts:419 → apps/engine/src/sync/loop.ts:322). Plan
    0012's M1 disabled the *interval* push; its M4 — not yet done — deletes
    `assembleSnapshot`/`pushProjectSnapshot` and replaces them with a status-write
    queue. Until then the route stays, constrained: `apps/vscode`, `apps/mcp` and
    `packages/cloud-client` never call it (and must not — see
    packages/cloud-client/src/client.ts), so when 0012 M4 lands nothing calls it and
    it can go. Retiring it does not touch the tracker mirror: `tracker_webhook`
    reaches `repo.upsert_graph` in-process, never through this router.

    Two things make it no weaker than the single-field routes beside it: the
    writer's authority domain comes from this code path rather than the request
    body (M2), and `_check_graph_write_permissions` applies the same role rules
    `set_task_status`, `assign_task` and `require_stage_access` apply (M3).
    """
    project = require_project(repo, project_id, user)
    _check_graph_write_permissions(repo, project, user, payload)
    # The writer's domain is the authenticated path, never `payload.source`: a
    # caller that declares its own authority domain can write any field it likes,
    # tracker-exclusive ones included (plan 0015 M2). This route is the local
    # author, so it is "pz" — hardcoded here exactly as every other in-process
    # caller hardcodes its own domain ("pmo" only inside the signature-verified
    # webhook, app/api/integrations.py).
    try:
        counts, conflicts = repo.upsert_graph(project_id, payload, source="pz")
    except CrossProjectWrite as exc:
        # An id in the payload already belongs to another project. Entity ids are
        # client-supplied, so this is reachable on purpose: taking the row would
        # have relocated and overwritten a task of a project this caller may not
        # even be a member of. Refuse the whole push rather than move the row.
        logger.warning(
            "graph push project=%s user=%s refused: %s %s belongs to project %s",
            project_id,
            user.id,
            exc.entity_type,
            exc.entity_id,
            exc.owner_project_id,
        )
        raise HTTPException(
            status_code=409, detail="entity_belongs_to_another_project"
        ) from exc
    cursor, _ = repo.changes_head(project_id)
    total = sum(counts.values())
    metrics = getattr(request.app.state, "metrics", None)
    if metrics is not None:
        metrics["pushed"] += 1
        metrics["merged"] += total
    logger.info(
        "graph push project=%s user=%s source=pz counts=%s",
        project_id,
        user.id,
        counts,
    )
    # Embed-on-ingest (M9): enqueue only, never block this push on a model
    # call. The worker skips nodes whose workspace has no model connection.
    # Only entity types that are both syncable (ENTITY_TYPES, i.e. actual
    # GraphUpsertRequest fields) and RAG-indexable (RAG_NODE_TYPES) apply —
    # RAG_NODE_TYPES also carries types with no sync-payload field at all
    # (M11's "pull_requests", indexed from a GitHub webhook, not a push).
    for node_type in ENTITY_TYPES:
        if node_type not in RAG_NODE_TYPES:
            continue
        for item in getattr(payload, node_type):
            enqueue(
                request.app,
                EmbedJob(project.workspace_id, project_id, node_type, item.id),
            )
    return GraphUpsertResponse(upserted=counts, cursor=cursor, conflicts=conflicts)


@router.get("/sync/projects/{project_id}/changes", response_model=ChangesHead)
def changes_head(
    project_id: str,
    since: datetime | None = Query(
        default=None,
        description="Cursor from the last pull; counts reflect changes strictly after it.",
    ),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ChangesHead:
    """Cheap sync head so a polling client can decide whether to pull. When
    `since == head` (nothing new) `has_changes` is False and the client skips
    the full graph pull entirely."""
    require_project(repo, project_id, user)
    cursor, counts = repo.changes_head(project_id, since=since)
    return ChangesHead(cursor=cursor, counts=counts, has_changes=bool(counts))


@router.get("/sync/projects/{project_id}/graph", response_model=ProjectGraph)
def pull_graph(
    project_id: str,
    since: datetime | None = Query(
        default=None,
        description="Return only entities updated strictly after this timestamp.",
    ),
    limit: int | None = Query(
        default=None, ge=1, le=5000, description="Max rows in this page (keyset paginated)."
    ),
    after_ts: datetime | None = Query(
        default=None, description="Keyset continuation: last page's cursor."
    ),
    after_id: str | None = Query(
        default=None, description="Keyset continuation: last page's next_id."
    ),
    request: Request = None,  # type: ignore[assignment]
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ProjectGraph:
    require_project(repo, project_id, user)
    metrics = getattr(request.app.state, "metrics", None) if request else None
    if metrics is not None:
        metrics["pulled"] += 1
    return repo.get_graph(
        project_id, since=since, limit=limit, after_ts=after_ts, after_id=after_id
    )
