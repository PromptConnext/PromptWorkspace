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
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api._guards import require_project, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.preview_url import (
    platform_preview_url,
    repo_full_name_from_url,
    resolves_before_repo,
)
from app.deployments.registry import PREVIEW_ENVIRONMENT
from app.deployments.registry import get_template as get_deployment_template
from app.integrations.deploy_providers import (
    PLATFORM_R2,
    ProviderCredentialError,
    ensure_platform_r2_credential,
    project_fields,
    resolve_provider_credential,
)
from app.integrations.deploy_providers import get_provider as get_deploy_provider
from app.integrations.github import (
    GithubWriteError,
    RepoAlreadyExistsError,
    ensure_hook_events,
    new_webhook_secret,
)
from app.integrations.github_auth import resolve_token
from app.integrations.repo_seed import build_deployment_files, build_seed_files
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
    RepoWebhook,
    Role,
    Task,
    TaskAssignmentUpdate,
    TaskStatus,
    TaskStatusUpdate,
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
logger = logging.getLogger("promptconnext.sync")


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

    # A second project importing the same repo would silently steal the
    # first's webhook binding (pz_repo_webhooks is keyed by repo_full_name) —
    # corrupting deploy state and build attribution for both with no error
    # anywhere downstream. Catch it here instead.
    for existing in repo.list_projects_by_workspace(body.workspace_id):
        if existing.repo_url and repo_full_name_from_url(existing.repo_url) == full_name:
            raise HTTPException(status_code=409, detail="repo_already_imported")

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

    return repo.create_project(
        workspace_id=body.workspace_id,
        created_by=user.id,
        name=body.name,
        repo_url=found["html_url"],
        repo_default_branch=found.get("default_branch") or "main",
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
      6. register the webhook and store its binding. This MUST also precede
         the seed commit, for a sharper reason: the first `deployment_status`
         can otherwise arrive before the binding row exists and be dropped as
         an unknown repository — losing exactly the first deploy's URL.
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
    stage_docs = {
        stage: (doc.content if doc else None)
        for stage, doc in (
            (s, repo.get_stage_document(project_id, s)) for s in _SEED_STAGES
        )
    }
    seed_files = build_seed_files(project, stage_docs)

    # Step 3: the deployment provider, still before any external mutation.
    # `deployment` is None for a project with no template selected, which is
    # a fully supported case — the repo is created and seeded exactly as it
    # was before this feature existed.
    try:
        deployment = await _resolve_deployment_provisioning(request.app, project, workspace)
    except ProviderCredentialError as exc:
        raise HTTPException(status_code=400, detail=exc.detail) from exc
    if deployment is not None:
        seed_files = seed_files + build_deployment_files(
            project, deployment["preview_url"], stage_docs.get("plan")
        )

    github_client = request.app.state.github_client

    name = body.name or _slugify(project.name)
    description = f"PromptZone-managed repository for project {project.id}"

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

    # Register this repo's webhook with its own freshly generated secret, so
    # PR/push indexing starts working without any further setup. Best-effort
    # on purpose: a failure here costs indexing, not the repo — and failing
    # the whole transition would strand a repo that is already created and
    # fully seeded. Skipped entirely when PUBLIC_API_URL is unset (local dev,
    # where GitHub cannot reach this service anyway).
    #
    # Step 6, and it runs BEFORE the seed commit on purpose: that commit
    # triggers the first deploy, and a delivery arriving before the binding
    # row exists is dropped as an unknown repository — silently losing the
    # first deploy's URL, which is the one the Tech Lead is watching for.
    public_api_url = request.app.state.settings.public_api_url
    if public_api_url:
        callback_url = f"{public_api_url.rstrip('/')}/api/webhooks/github"
        secret = new_webhook_secret()
        try:
            await github_client.create_repo_webhook(token, full_name, callback_url, secret)
            # `create_repo_webhook` treats GitHub's 422 "already exists" as
            # success, so on the adopt-a-repo retry path it may have changed
            # nothing at all — including leaving an older hook subscribed to
            # the pre-ADR-0021 event list. Widening is idempotent and cheap,
            # so it runs unconditionally rather than only on the retry path.
            await ensure_hook_events(github_client, token, full_name, callback_url)
        except GithubWriteError:
            logger.warning("webhook registration failed for %s; indexing will not start", full_name)
        else:
            # The *unscoped* repository, not the caller-scoped `repo`:
            # migration 0020 revokes pz_repo_webhooks from `authenticated` on
            # purpose (a webhook signing secret must never be reachable from a
            # browser session), and app/dependencies.py::get_repository hands
            # every authenticated route a JWT-scoped client running as exactly
            # that role. Only the service key may write this binding.
            service_repo = request.app.state.repository
            try:
                service_repo.upsert_repo_webhook(
                    RepoWebhook(
                        repo_full_name=full_name,
                        project_id=project_id,
                        workspace_id=project.workspace_id,
                        secret_ref=request.app.state.secret_store.encrypt(secret),
                    )
                )
            except Exception:  # noqa: BLE001 - bookkeeping must not strand the repo
                # Same best-effort reasoning as the registration call above,
                # and the same cost: without the stored secret no delivery for
                # this repo can be verified, so indexing stays dark until the
                # binding is written. The repo itself is created and seeded.
                logger.exception(
                    "storing the webhook binding for %s failed; indexing will not start",
                    full_name,
                )

    # Step 7: one commit, not one per file. See
    # github.py::create_commit_with_files — this is what collapses the
    # partial-seed window to a single atomic ref update, and it is also what
    # keeps a forty-file scaffold inside one HTTP request.
    try:
        await github_client.create_commit_with_files(
            token,
            full_name,
            default_branch,
            seed_files,
            "chore: seed project context from PromptZone",
        )
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
    repo.update_project_repo(project_id, created["html_url"], created["id"], default_branch)
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
    return repo.update_project_lifecycle_status(project_id, "repo_created")


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
    """`PZ_R2_ACCESS_KEY_ID` -> `access_key_id`. Lets a template name the
    Actions secret its workflow reads without the provider having to know
    that name, and vice versa."""
    return secret_name.removeprefix("PZ_").lower().removeprefix("r2_")


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
    overwrite a tracker's rename) and whose `acceptance_criteria` is a pz-owned
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
    project = require_project(repo, project_id, user)
    counts, conflicts = repo.upsert_graph(project_id, payload, source=payload.source)
    cursor, _ = repo.changes_head(project_id)
    total = sum(counts.values())
    metrics = getattr(request.app.state, "metrics", None)
    if metrics is not None:
        metrics["pushed"] += 1
        metrics["merged"] += total
    logger.info(
        "graph push project=%s user=%s source=%s counts=%s",
        project_id,
        user.id,
        payload.source,
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
