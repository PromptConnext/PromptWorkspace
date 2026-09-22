"""Repository layer — the data-access seam.

Two implementations share one interface:
  * InMemoryRepository  — no external deps; used for tests and local dev.
  * SupabaseRepository  — persists to Postgres via the Supabase client.

Keeping this seam means the Sync API never talks to Supabase directly, so the
whole backend is runnable and testable without credentials.
"""

from __future__ import annotations

import abc
import copy
import threading
from datetime import datetime, timedelta

from app.db.merge import incoming_dump as _incoming_dump
from app.db.merge import merge_entity
from app.db.merge import unwritten_fields as _unwritten_fields
from app.models.schemas import (
    ENTITY_TYPES,
    FIELD_AUTHORITY,
    FIELD_DEFAULTS,
    Artifact,
    ArtifactKind,
    AssignedTask,
    CodeChunk,
    CodeChunkHit,
    Deployment,
    DeploymentConfig,
    DeploymentState,
    Document,
    GenerationRun,
    GraphEntity,
    GraphUpsertRequest,
    Invitation,
    InvitationStatus,
    ModelConnection,
    PolicyScope,
    Project,
    ProjectGraph,
    PullRequest,
    RagChunk,
    RagChunkHit,
    RepoWebhook,
    Requirement,
    Role,
    SpecDocument,
    StageDocument,
    Task,
    TaskLink,
    TaskStatus,
    Workspace,
    WorkspaceIntegration,
    WorkspaceMember,
    new_id,
    utcnow,
)


class TrackerAccountConflict(ValueError):
    """Another workspace is already bound to this tracker account.

    `pz_workspace_integrations` is unique on `(provider, account_key)` since
    migration 0032, and that uniqueness is the whole mechanism of plan 0019: if
    two workspaces could both claim `https://acme.atlassian.net`, an inbound
    delivery from that site would again have two possible owners and the
    first-match routing bug would be back. Surfaced to a caller that faces a
    client as a 409 (`app/api/integrations.py::configure_integration`).
    """

    def __init__(self, provider: str, account_key: str) -> None:
        super().__init__(f"{provider} account {account_key} is bound to another workspace")
        self.provider = provider
        self.account_key = account_key


class CrossProjectWrite(ValueError):
    """An upsert named an entity id that already belongs to a different project.

    Entity ids are client-supplied and globally unique (a uuid primary key), so
    "the row for this id" and "a row in this project" are not the same lookup.
    Taking the second for the first let a push into project B rewrite a row of
    project A's — `project_id` and all — relocating and overwriting somebody
    else's task with no error and no conflict reported. The row is never moved
    between projects: every adapter refuses the whole write instead, and callers
    that face a client turn this into a 4xx (see `app/api/sync.py::push_graph`).
    """

    def __init__(self, entity_type: str, entity_id: str, owner_project_id: str) -> None:
        super().__init__(
            f"{entity_type} id {entity_id} belongs to project {owner_project_id}"
        )
        self.entity_type = entity_type
        self.entity_id = entity_id
        self.owner_project_id = owner_project_id


class Repository(abc.ABC):
    backend_name: str = "abstract"

    # -- workspaces ------------------------------------------------------- #
    @abc.abstractmethod
    def create_workspace(
        self, name: str, created_by: str, created_by_email: str | None = None
    ) -> Workspace:
        """Create a workspace and add the creator as its first admin."""

    @abc.abstractmethod
    def get_workspace(self, workspace_id: str) -> Workspace | None: ...

    @abc.abstractmethod
    def list_workspaces(self, user_id: str) -> list[Workspace]:
        """Workspaces the user is a member of."""

    @abc.abstractmethod
    def update_workspace(
        self,
        workspace_id: str,
        *,
        name: str | None = None,
        git_config: dict | None = None,
        integration_config: dict | None = None,
        rag_index_pmo_discussions: bool | None = None,
    ) -> Workspace: ...

    @abc.abstractmethod
    def upsert_repo_webhook(self, webhook: RepoWebhook) -> RepoWebhook:
        """Bind a repository to the project whose repo it is, together with
        that repo's own signing secret. Keyed by `repo_full_name`."""

    @abc.abstractmethod
    def create_repo_webhook_if_absent(self, webhook: RepoWebhook) -> tuple[RepoWebhook, bool]:
        """Atomically reserve a binding, returning ``(stored, created)``.

        The first caller's signing secret wins. This differs from ``upsert``:
        two overlapping repository-creation retries must never replace an
        already-reserved secret after GitHub has accepted it.
        """

    @abc.abstractmethod
    def claim_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        """Claim an unlocked pending binding before registering it remotely."""

    @abc.abstractmethod
    def release_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        """Release a pending registration claim after a retryable failure."""

    @abc.abstractmethod
    def confirm_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        """Mark a claimed binding confirmed after GitHub accepted its secret."""

    @abc.abstractmethod
    def delete_repo_webhook_if_matches(self, webhook: RepoWebhook, owner: str) -> bool:
        """Remove a provisional binding only when it still equals ``webhook``.

        A duplicate remote hook with no earlier local binding has an unknown
        signing secret. Callers use this compare-and-delete operation to
        discard their provisional secret without deleting another request's
        binding.
        """

    @abc.abstractmethod
    def get_repo_webhook(self, repo_full_name: str) -> RepoWebhook | None:
        """Resolve an inbound GitHub delivery (no caller identity, just a
        `repository.full_name`) to the project it belongs to. Replaces the
        old workspace-config scan: the binding is written by the cloud when
        it creates the repo, so it cannot be claimed by a workspace that
        merely typed the repo's name (see issue #3)."""

    @abc.abstractmethod
    def get_membership(self, workspace_id: str, user_id: str) -> Role | None: ...

    @abc.abstractmethod
    def list_members(self, workspace_id: str) -> list[WorkspaceMember]: ...

    @abc.abstractmethod
    def add_member(
        self,
        workspace_id: str,
        user_id: str,
        role: Role,
        invited_by: str | None = None,
        email: str | None = None,
    ) -> WorkspaceMember: ...

    @abc.abstractmethod
    def remove_member(self, workspace_id: str, user_id: str) -> None: ...

    @abc.abstractmethod
    def create_invitation(self, invitation: Invitation) -> Invitation: ...

    @abc.abstractmethod
    def get_invitation(self, token: str) -> Invitation | None: ...

    @abc.abstractmethod
    def accept_invitation(self, token: str, user_id: str) -> WorkspaceMember:
        """Consume a pending, unexpired invitation and add the user as a member."""

    # -- projects --------------------------------------------------------- #
    @abc.abstractmethod
    def create_project(
        self,
        workspace_id: str,
        created_by: str,
        name: str,
        *,
        repo_url: str | None = None,
        repo_default_branch: str | None = None,
        repo_id: int | None = None,
    ) -> Project: ...

    @abc.abstractmethod
    def get_project(self, project_id: str) -> Project | None: ...

    @abc.abstractmethod
    def find_project_by_repo_id(self, repo_id: int) -> Project | None:
        """The project, in any workspace, whose repo_id matches — deliberately
        unscoped by membership, since this exists to detect a repository
        already claimed by a workspace the caller may not belong to (plan
        0016 M5)."""

    @abc.abstractmethod
    def list_projects(self, user_id: str) -> list[Project]:
        """Projects across every workspace the user is a member of."""

    @abc.abstractmethod
    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]: ...

    @abc.abstractmethod
    def list_assigned_tasks(
        self,
        user_id: str,
        workspace_id: str | None = None,
        statuses: list[TaskStatus] | None = None,
        limit: int = 200,
    ) -> list[AssignedTask]:
        """Every live task assigned to `user_id`, across every workspace they
        belong to, with project and workspace context attached.

        Implementations MUST re-check membership per row rather than trusting
        the assignment: an assignment outlives a membership removal, so a
        removed member would otherwise keep reading their old tasks."""

    @abc.abstractmethod
    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project: ...

    @abc.abstractmethod
    def update_project_policy_scope(self, project_id: str, scope: PolicyScope | None) -> Project:
        """Replace the whole policy scope atomically (last-write-wins);
        `None` clears it. Bumps `updated_at`."""

    @abc.abstractmethod
    def update_project_deployment_config(
        self, project_id: str, config: DeploymentConfig | None
    ) -> Project:
        """Replace the Tech Lead's deployment-template selection (ADR 0021);
        `None` clears it. Frozen at `repo_created` by the router, not here."""

    @abc.abstractmethod
    def update_project_deployment_state(self, project_id: str, state: DeploymentState) -> Project:
        """Replace the denormalized current deployment view. Written only by
        the signed webhook path and by repo creation — never by a member."""

    @abc.abstractmethod
    def upsert_deployment(self, deployment: Deployment) -> Deployment:
        """Insert or update by `(project_id, external_key)`. One deploy emits
        several deliveries, so this must update in place rather than append —
        that key is exactly what makes the second delivery idempotent."""

    @abc.abstractmethod
    def list_deployments(self, project_id: str, limit: int = 10) -> list[Deployment]:
        """Newest first."""

    @abc.abstractmethod
    def get_latest_deployment(self, project_id: str) -> Deployment | None: ...

    @abc.abstractmethod
    def freeze_deployment_tasks(
        self, deployment_id: str, task_ids: list[str], now: datetime
    ) -> bool:
        """Write this build's task set, once. Returns whether it wrote.

        Freeze, not set. `False` means the deployment was already `frozen` (or
        no longer exists) and nothing was touched — the normal, expected answer
        to a webhook redelivery, not an error. Callers read the stored set back
        rather than trusting the list they just computed, because on a `False`
        the two can legitimately differ and the stored one is the record.

        Three properties, all load-bearing, all required of every adapter:

          * **Idempotent.** GitHub redelivers deliveries at will and the
            reconciliation sweep re-visits terminal rows. A second pass must
            not recompute — not because recomputing is expensive, but because
            the graph may have changed underneath and rewriting what somebody
            reviewed last Tuesday is the defect plan 0024 M2 closes.
          * **Atomic.** The replace and the state stamp land together or not
            at all. The previous shape issued a delete and an insert as two
            calls, so a failure between them erased the record instead of
            leaving it stale.
          * **Ordered.** `position` preserves the caller's order so the
            Preview tab's list reads the same way twice.

        Replace rather than append is retained from the original contract, but
        it is now a detail of the single write rather than a defence against a
        second pass — there is no second pass.
        """

    @abc.abstractmethod
    def clear_deployment_attribution(self, deployment_id: str) -> bool:
        """Return a build to `uncomputed` so it can be attributed again.

        The *only* way the frozen flag clears, and it exists for one named
        case: attribution that froze while the workspace PAT was missing or
        GitHub was unreachable, where the commit-range lookup was swallowed
        and the set fell back to the head commit alone — honestly incomplete.
        Reached solely from the admin-only reattribute endpoint, never from a
        webhook or a sweep. Returns False when there is no such deployment."""

    @abc.abstractmethod
    def list_deployment_tasks(self, deployment_id: str) -> list[str]:
        """The frozen task ids for one build, in the order they were stored."""

    @abc.abstractmethod
    def list_stale_deployments(self, older_than: datetime, limit: int = 50) -> list[Deployment]:
        """Non-terminal deployments last touched before `older_than`, oldest
        first, across every project.

        Cross-project on purpose: this backs a periodic sweep, not a request,
        and asking per project would mean walking every project every pass."""

    @abc.abstractmethod
    def update_project_repo(
        self, project_id: str, repo_url: str, repo_id: int, default_branch: str
    ) -> Project:
        """Persist the GitHub repo this project was born into at the
        `tech_review -> repo_created` transition (see app/api/sync.py's
        `create_repository`). Written before the lifecycle status flips, so a
        crash mid-transition leaves `repo_url` set with status still
        `tech_review` — the state a retry treats as adoptable. `repo_id` is
        GitHub's numeric id, the identity a later collision check verifies
        against (plan 0016) — `repo_url` alone is a lookup key, not proof of
        provenance."""

    @abc.abstractmethod
    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]: ...

    @abc.abstractmethod
    def list_invitations_for_email(
        self, email: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        """Invitations addressed to `email`, across every workspace.

        The invitee is not a member yet, so this is deliberately *not*
        workspace-scoped — it is the only lookup that lets an invited user find
        the workspace they were invited to. Matched case-insensitively, since
        the inviter types the address by hand."""

    @abc.abstractmethod
    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation: ...

    @abc.abstractmethod
    def upsert_graph(
        self,
        project_id: str,
        payload: GraphUpsertRequest,
        source: str = "pz",
        seed_fields: frozenset[str] = frozenset(),
    ) -> tuple[dict[str, int], dict[str, list[str]]]:
        """Merge a graph delta into `project_id`, returning (counts, conflicts).

        `source` is the writer's authority domain and is always a literal at the
        call site — never a value taken from a request body (plan 0015 M2).
        `seed_fields` lets the in-process Planner author a field it does not own
        at creation (`merge.PLANNER_SEED_FIELDS`); every client-facing caller
        leaves it empty.

        Raises `CrossProjectWrite` — before writing anything — if any id in the
        payload already belongs to another project.
        """

    @abc.abstractmethod
    def get_graph(
        self,
        project_id: str,
        since: datetime | None = None,
        limit: int | None = None,
        after_ts: datetime | None = None,
        after_id: str | None = None,
    ) -> ProjectGraph:
        """Pull the graph. `since` selects mode (bootstrap = live only;
        incremental = everything changed after it, tombstones included).
        `limit` + (`after_ts`,`after_id`) give keyset pagination.

        The pagination contract (plan 0013), binding on every adapter, because a
        client that drains this endpoint has no other way to know it holds the
        whole graph:

        **Ordering key.** Candidate rows are ordered globally by
        `(updated_at, id)` across *all* of `ENTITY_TYPES` — one sequence, not six
        per-table sequences. Which table a row came from never affects its
        position.

        **The keyset predicate is exclusive, and applied first.** Given
        `after_ts` (and `after_id`), a row is a candidate only if
        `updated_at > after_ts`, or `updated_at == after_ts and id > after_id`.
        With `after_ts` set and `after_id` None, every row at exactly `after_ts`
        is already consumed. That predicate is applied in full, as an exclusive
        bound, *before* any row is counted against `limit` — never as an
        inclusive bound that a page-sized fetch truncates and application code
        then refines, which can hand back a page of entirely already-seen rows
        (so: empty) while unseen rows wait behind them.

        **`limit` counts the page, not the table.** It bounds the total number of
        rows returned across all entity types. A `limit=50` pull returns at most
        50 rows however they split across the six lists.

        **What the response reports.** `has_more` is True if and only if
        candidate rows existed beyond the page returned. When it is True,
        `cursor` and `next_id` are the `(updated_at, id)` of the last row in the
        page, and a client resending them as `after_ts=cursor, after_id=next_id`
        receives the next page with no gap and no duplicate. When `has_more` is
        False the graph is drained at `cursor` and `next_id` is None; re-pulling
        at the final cursor is idempotent and returns an empty page. An empty
        page with `has_more` False therefore means drained, and nothing else.

        `cursor` is the last returned row's `updated_at`, or — when the page is
        empty — the position the caller asked from (`after_ts`, else `since`), so
        a drained client's cursor never rewinds."""

    @abc.abstractmethod
    def changes_head(
        self, project_id: str, since: datetime | None = None
    ) -> tuple[datetime | None, dict[str, int]]:
        """Return (max cursor, per-entity changed counts since `since`) without
        materialising rows — the cheap "is there anything to pull" probe (M4)."""

    @abc.abstractmethod
    def get_task(self, project_id: str, task_id: str) -> Task | None: ...

    @abc.abstractmethod
    def assign_task(
        self, project_id: str, task_id: str, assigned_user_id: str | None, now: datetime
    ) -> Task:
        """Single-field pz write of `assigned_user_id`, stamping its field
        version. Raises KeyError if the task doesn't exist."""

    @abc.abstractmethod
    def set_task_status(
        self, project_id: str, task_id: str, status: TaskStatus, now: datetime
    ) -> Task:
        """Single-field pz write of `status`, stamping its field version. The
        twin of `assign_task`, and for the same reason (ADR 0020): a full-graph
        push cannot express "only the status changed" — `title` is shared
        authority and `acceptance_criteria` is a pz-owned list that a
        `model_dump` cannot distinguish from "cleared".

        Raises KeyError if the task doesn't exist."""

    @abc.abstractmethod
    def upsert_task_artifact(
        self,
        project_id: str,
        task_id: str,
        uri: str,
        commit_sha: str | None,
        kind: ArtifactKind,
        now: datetime,
    ) -> Artifact:
        """Append evidence for a status change (the commit that closed a task).

        Idempotent on (task_id, commit_sha) when commit_sha is not None. That
        is load-bearing rather than tidy: the git-driven caller replays commits
        whenever its local cache is dropped or a repo is re-cloned, so a
        duplicate write is the expected case, not the exceptional one."""

    @abc.abstractmethod
    def get_node(
        self, project_id: str, node_type: str, node_id: str
    ) -> GraphEntity | PullRequest | Document | None:
        """Fetch any graph entity by (project, type, id) — used by the RAG
        embed worker, which handles requirements/spec_documents/tasks
        uniformly (M9). Also handles node_type="pull_requests" (M11) and
        node_type="documents" (M0), neither of which is a GraphEntity (no
        pz/pmo merge lifecycle), but both still expose `deleted_at` for the
        worker's tombstone check."""

    # -- external-tracker links (M5) -------------------------------------- #
    @abc.abstractmethod
    def upsert_task_link(self, link: TaskLink) -> TaskLink: ...

    @abc.abstractmethod
    def get_task_link(self, task_id: str, provider: str) -> TaskLink | None: ...

    @abc.abstractmethod
    def find_task_link_by_key(
        self, provider: str, account_key: str, external_key: str
    ) -> TaskLink | None:
        """Resolve an inbound webhook's external key to a PromptConnext task.

        `account_key` is not optional and not a convenience filter: an external
        key identifies an issue only within one provider account (plan 0019), so
        a lookup without it is the cross-tenant bug. Callers pass the
        `account_key` of the account whose secret *verified* the delivery, never
        one taken from the payload's own claims.
        """

    # -- tracker account bindings (plan 0019) ------------------------------ #
    @abc.abstractmethod
    def upsert_workspace_integration(
        self, integration: WorkspaceIntegration
    ) -> WorkspaceIntegration:
        """Bind a workspace to one tracker account, with that account's secret.

        Raises `TrackerAccountConflict` when another workspace already holds
        `(provider, account_key)` — the `unique` constraint in migration 0032 is
        the authority, and the in-memory backend enforces the same rule so the
        two adapters cannot disagree about it.
        """

    @abc.abstractmethod
    def get_workspace_integration(
        self, workspace_id: str, provider: str
    ) -> WorkspaceIntegration | None: ...

    @abc.abstractmethod
    def find_workspace_integration_by_account(
        self, provider: str, account_key: str
    ) -> WorkspaceIntegration | None:
        """The one workspace bound to this provider account, or None.

        The inbound webhook route's first step: it selects whose secret the
        delivery is verified against, so an unrecognized account is dropped
        before its payload is trusted at all.
        """

    @abc.abstractmethod
    def purge_expired_tombstones(self, ttl_days: int) -> dict[str, int]:
        """Hard-delete rows tombstoned (`deleted_at` set) longer than `ttl_days`
        ago. Never touches live rows or recent tombstones. Returns per-entity
        purge counts. See docs/plans/0001-cloud-deletes-and-auth.md (M1 GC)."""

    # -- RAG assistant v1 (M9) --------------------------------------------- #
    @abc.abstractmethod
    def get_model_connection(self, workspace_id: str) -> ModelConnection | None: ...

    @abc.abstractmethod
    def upsert_model_connection(
        self,
        *,
        workspace_id: str,
        provider: str,
        base_url: str,
        model: str,
        embed_model: str,
        embed_dim: int,
        secret_ref: str,
        daily_token_budget: int,
        created_by: str,
    ) -> ModelConnection: ...

    @abc.abstractmethod
    def upsert_rag_chunks(
        self,
        workspace_id: str,
        project_id: str,
        node_type: str,
        node_id: str,
        chunks: list[str],
        embeddings: list[list[float]],
        embed_model: str = "",
        embed_dim: int = 0,
    ) -> None:
        """Replace all stored chunks for one node — wholesale, so a shrinking
        node doesn't leave stale trailing chunks behind."""

    @abc.abstractmethod
    def delete_rag_chunks_for_node(self, node_id: str) -> int: ...

    @abc.abstractmethod
    def get_project_embed_model(self, workspace_id: str, project_id: str) -> str | None:
        """The embed model recorded on this project's existing chunks, or
        `None` if it has none yet (plan 0008 M1) — used to detect an
        embedding-source switch that would otherwise silently mix
        incompatible vector dimensions in the same column."""

    @abc.abstractmethod
    def get_project_embed_dim(self, workspace_id: str, project_id: str) -> int | None:
        """The embed dimension recorded on this project's existing chunks,
        or `None` if it has none yet (migration 0023) — the width sibling of
        `get_project_embed_model`. Needed once `pz_rag_chunks.embedding`'s
        width stopped being a fixed `vector(1536)` constant: two connections
        can share an `embed_model` name and still disagree on width (e.g. an
        MRL-truncated dimension), and a width mismatch is worse than a name
        mismatch — the vectors don't even fit the column."""

    @abc.abstractmethod
    def count_project_rag_chunks(self, workspace_id: str, project_id: str) -> int:
        """How many chunks currently exist for this project — the honest
        "did the last reindex actually do anything" signal for
        GET /projects/{id}/assistant/index-status."""

    @abc.abstractmethod
    def vector_search(
        self,
        workspace_id: str,
        project_id: str,
        query_embedding: list[float],
        top_k: int = 8,
    ) -> list[RagChunkHit]:
        """Nearest-neighbour search, pre-filtered to (workspace_id,
        project_id) — membership scoping happens before similarity, per
        ADR 0011."""

    # -- Git-host integration (M11) ---------------------------------------- #
    @abc.abstractmethod
    def upsert_pull_request(self, pr: PullRequest) -> PullRequest:
        """Keyed by pr.id (deterministic: f"pr-{project_id}-{number}") —
        idempotent across repeated webhook deliveries and PR state
        transitions (opened -> merged)."""

    @abc.abstractmethod
    def upsert_code_chunks(
        self,
        workspace_id: str,
        project_id: str,
        repo: str,
        path: str,
        sha: str,
        line_ranges: list[tuple[int, int]],
        embeddings: list[list[float]],
    ) -> None:
        """Replace all stored chunks for one (repo, path) — wholesale, so a
        shrinking file doesn't leave stale trailing chunks, and re-embedding
        at a new `sha` supersedes the old one. Deliberately takes no chunk
        text parameter — only line ranges and their embeddings ever reach
        storage (ADR 0011: no source code at rest)."""

    @abc.abstractmethod
    def delete_code_chunks_for_path(self, project_id: str, repo: str, path: str) -> int:
        """Called for files a push removed."""

    @abc.abstractmethod
    def code_vector_search(
        self,
        workspace_id: str,
        project_id: str,
        query_embedding: list[float],
        top_k: int = 8,
    ) -> list[CodeChunkHit]:
        """Same membership-scoping-before-similarity contract as
        `vector_search`, over the separate no-content code index."""

    # -- Documents knowledge base (M0) -------------------------------------- #
    @abc.abstractmethod
    def create_document(self, document: Document) -> Document: ...

    @abc.abstractmethod
    def get_document(self, project_id: str, document_id: str) -> Document | None: ...

    @abc.abstractmethod
    def list_documents(self, project_id: str) -> list[Document]: ...

    @abc.abstractmethod
    def update_document_extraction(
        self,
        project_id: str,
        document_id: str,
        *,
        status: str,
        extract_method: str | None,
        extracted_text: str | None,
    ) -> Document: ...

    # -- Generation (M1) ----------------------------------------------------- #
    @abc.abstractmethod
    def get_latest_requirement(self, project_id: str) -> Requirement | None:
        """Most recently updated, non-tombstoned requirement — the "run
        specify first" prerequisite for the `plan` stage."""

    @abc.abstractmethod
    def get_latest_spec_document(self, project_id: str) -> SpecDocument | None:
        """Most recently updated, non-tombstoned spec document — the "run
        plan first" prerequisite for the `tasks` stage."""

    @abc.abstractmethod
    def create_generation_run(self, run: GenerationRun) -> GenerationRun: ...

    @abc.abstractmethod
    def update_generation_run(
        self,
        run_id: str,
        *,
        status: str,
        prompt_tokens: int,
        completion_tokens: int,
    ) -> GenerationRun: ...

    @abc.abstractmethod
    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None: ...

    @abc.abstractmethod
    def upsert_stage_document(
        self, project_id: str, workspace_id: str, stage: str, content: str, user_id: str
    ) -> StageDocument: ...

class InMemoryRepository(Repository):
    """Process-local store. State is lost on restart — dev/test only."""

    backend_name = "memory"

    def __init__(self) -> None:
        self._projects: dict[str, Project] = {}
        # project_id -> entity_type -> entity_id -> entity instance
        self._graph: dict[str, dict[str, dict[str, object]]] = {}
        self._workspaces: dict[str, Workspace] = {}
        # workspace_id -> user_id -> WorkspaceMember
        self._members: dict[str, dict[str, WorkspaceMember]] = {}
        # token -> Invitation
        self._invitations: dict[str, Invitation] = {}
        self._repo_webhooks: dict[str, RepoWebhook] = {}
        self._repo_webhooks_lock = threading.Lock()
        # project_id -> external_key -> Deployment (ADR 0021). Keyed by the
        # idempotency key so a repeated delivery updates rather than appends,
        # mirroring the supabase table's unique (project_id, external_key).
        self._deployments: dict[str, dict[str, Deployment]] = {}
        self._deployment_tasks: dict[str, list[str]] = {}
        # (provider, account_key, external_key) -> TaskLink. Three columns, not
        # two, since plan 0019: an issue key is unique per provider account.
        self._task_links: dict[tuple[str, str, str], TaskLink] = {}
        # (workspace_id, provider) -> WorkspaceIntegration (plan 0019)
        self._workspace_integrations: dict[tuple[str, str], WorkspaceIntegration] = {}
        self._workspace_integrations_lock = threading.Lock()
        # workspace_id -> ModelConnection (M9)
        self._model_connections: dict[str, ModelConnection] = {}
        # project_id -> node_id -> chunk_index -> RagChunk (M9)
        self._rag_chunks: dict[str, dict[str, dict[int, RagChunk]]] = {}
        # project_id -> pr_id -> PullRequest (M11)
        self._pull_requests: dict[str, dict[str, PullRequest]] = {}
        # project_id -> (repo, path) -> chunk_index -> CodeChunk (M11)
        self._code_chunks: dict[str, dict[tuple[str, str], dict[int, CodeChunk]]] = {}
        # project_id -> document_id -> Document (M0)
        self._documents: dict[str, dict[str, Document]] = {}
        # generation_run_id -> GenerationRun (M1)
        self._generation_runs: dict[str, GenerationRun] = {}
        # project_id -> stage -> StageDocument (Planner editable-markdown)
        self._stage_documents: dict[str, dict[str, StageDocument]] = {}

    # -- workspaces ------------------------------------------------------- #
    def create_workspace(
        self, name: str, created_by: str, created_by_email: str | None = None
    ) -> Workspace:
        ws = Workspace(name=name, created_by=created_by)
        self._workspaces[ws.id] = ws
        self._members[ws.id] = {}
        self.add_member(
            ws.id, created_by, Role.admin, invited_by=created_by, email=created_by_email
        )
        return ws

    def get_workspace(self, workspace_id: str) -> Workspace | None:
        return self._workspaces.get(workspace_id)

    def list_workspaces(self, user_id: str) -> list[Workspace]:
        return [
            ws
            for ws in self._workspaces.values()
            if user_id in self._members.get(ws.id, {})
        ]

    def update_workspace(
        self,
        workspace_id: str,
        *,
        name: str | None = None,
        git_config: dict | None = None,
        integration_config: dict | None = None,
        rag_index_pmo_discussions: bool | None = None,
    ) -> Workspace:
        ws = self._workspaces[workspace_id]
        if name is not None:
            ws.name = name
        if git_config is not None:
            ws.git_config = git_config
        if integration_config is not None:
            ws.integration_config = integration_config
        if rag_index_pmo_discussions is not None:
            ws.rag_index_pmo_discussions = rag_index_pmo_discussions
        ws.updated_at = utcnow()
        return ws

    def upsert_repo_webhook(self, webhook: RepoWebhook) -> RepoWebhook:
        self._repo_webhooks[webhook.repo_full_name] = webhook
        return webhook

    def create_repo_webhook_if_absent(self, webhook: RepoWebhook) -> tuple[RepoWebhook, bool]:
        with self._repo_webhooks_lock:
            stored = self._repo_webhooks.get(webhook.repo_full_name)
            if stored is not None:
                return stored, False
            self._repo_webhooks[webhook.repo_full_name] = webhook
            return webhook, True

    def claim_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        with self._repo_webhooks_lock:
            stored = self._repo_webhooks.get(webhook.repo_full_name)
            if (
                stored != webhook
                or stored.registration_state != "pending"
                or stored.registration_owner is not None
            ):
                return False
            stored.registration_owner = owner
            return True

    def release_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        with self._repo_webhooks_lock:
            stored = self._repo_webhooks.get(webhook.repo_full_name)
            if (
                stored is None
                or stored.registration_state != "pending"
                or stored.registration_owner != owner
            ):
                return False
            stored.registration_owner = None
            return True

    def confirm_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        with self._repo_webhooks_lock:
            stored = self._repo_webhooks.get(webhook.repo_full_name)
            if (
                stored is None
                or stored.registration_state != "pending"
                or stored.registration_owner != owner
            ):
                return False
            stored.registration_state = "confirmed"
            stored.registration_owner = None
            return True

    def delete_repo_webhook_if_matches(self, webhook: RepoWebhook, owner: str) -> bool:
        with self._repo_webhooks_lock:
            stored = self._repo_webhooks.get(webhook.repo_full_name)
            if (
                stored is None
                or stored.registration_state != "pending"
                or stored.registration_owner != owner
                or stored.secret_ref != webhook.secret_ref
                or stored.project_id != webhook.project_id
                or stored.workspace_id != webhook.workspace_id
            ):
                return False
            del self._repo_webhooks[webhook.repo_full_name]
            return True

    def get_repo_webhook(self, repo_full_name: str) -> RepoWebhook | None:
        return self._repo_webhooks.get(repo_full_name)

    def get_membership(self, workspace_id: str, user_id: str) -> Role | None:
        member = self._members.get(workspace_id, {}).get(user_id)
        return member.role if member else None

    def list_members(self, workspace_id: str) -> list[WorkspaceMember]:
        return list(self._members.get(workspace_id, {}).values())

    def add_member(
        self,
        workspace_id: str,
        user_id: str,
        role: Role,
        invited_by: str | None = None,
        email: str | None = None,
    ) -> WorkspaceMember:
        member = WorkspaceMember(
            workspace_id=workspace_id,
            user_id=user_id,
            role=role,
            invited_by=invited_by,
            email=email,
        )
        self._members.setdefault(workspace_id, {})[user_id] = member
        return member

    def remove_member(self, workspace_id: str, user_id: str) -> None:
        self._members.get(workspace_id, {}).pop(user_id, None)

    def create_invitation(self, invitation: Invitation) -> Invitation:
        self._invitations[invitation.token] = invitation
        return invitation

    def get_invitation(self, token: str) -> Invitation | None:
        return self._invitations.get(token)

    def accept_invitation(self, token: str, user_id: str) -> WorkspaceMember:
        inv = self._invitations.get(token)
        if inv is None:
            raise KeyError("invitation_not_found")
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        if inv.expires_at <= utcnow():
            inv.status = InvitationStatus.expired
            raise ValueError("invitation_expired")
        inv.status = InvitationStatus.accepted
        return self.add_member(
            inv.workspace_id, user_id, inv.role, invited_by=inv.invited_by, email=inv.email
        )

    # -- projects --------------------------------------------------------- #
    def create_project(
        self,
        workspace_id: str,
        created_by: str,
        name: str,
        *,
        repo_url: str | None = None,
        repo_default_branch: str | None = None,
        repo_id: int | None = None,
    ) -> Project:
        project = Project(
            name=name,
            workspace_id=workspace_id,
            owner_id=created_by,
            repo_url=repo_url,
            repo_default_branch=repo_default_branch,
            repo_id=repo_id,
        )
        self._projects[project.id] = project
        self._graph[project.id] = {etype: {} for etype in ENTITY_TYPES}
        return project

    def get_project(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def find_project_by_repo_id(self, repo_id: int) -> Project | None:
        for project in self._projects.values():
            if project.repo_id == repo_id:
                return project
        return None

    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(update={"lifecycle_status": status, "updated_at": utcnow()})
        self._projects[project_id] = updated
        return updated

    def update_project_repo(
        self, project_id: str, repo_url: str, repo_id: int, default_branch: str
    ) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(
            update={
                "repo_url": repo_url,
                "repo_id": repo_id,
                "repo_default_branch": default_branch,
                "updated_at": utcnow(),
            }
        )
        self._projects[project_id] = updated
        return updated

    def update_project_policy_scope(self, project_id: str, scope: PolicyScope | None) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(update={"policy_scope": scope, "updated_at": utcnow()})
        self._projects[project_id] = updated
        return updated

    def update_project_deployment_config(
        self, project_id: str, config: DeploymentConfig | None
    ) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(
            update={"deployment_config": config, "updated_at": utcnow()}
        )
        self._projects[project_id] = updated
        return updated

    def update_project_deployment_state(self, project_id: str, state: DeploymentState) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(update={"deployment_state": state, "updated_at": utcnow()})
        self._projects[project_id] = updated
        return updated

    def upsert_deployment(self, deployment: Deployment) -> Deployment:
        by_key = self._deployments.setdefault(deployment.project_id, {})
        existing = by_key.get(deployment.external_key)
        if existing is not None:
            # Preserve the original id and creation time: this is the same
            # deploy reporting again, not a new one.
            #
            # The attribution fields are preserved for a sharper reason: they
            # are owned by freeze_deployment_tasks, not by the webhook payload
            # this row was built from. Every caller constructs a fresh
            # Deployment from the delivery, so without this a redelivery would
            # write the model default ('uncomputed') straight over a frozen
            # row and the next freeze would happily recompute — defeating the
            # whole of plan 0024 M2 through the back door.
            deployment = deployment.model_copy(
                update={
                    "id": existing.id,
                    "created_at": existing.created_at,
                    "updated_at": utcnow(),
                    "attribution_state": existing.attribution_state,
                    "attributed_at": existing.attributed_at,
                }
            )
        by_key[deployment.external_key] = deployment
        return copy.deepcopy(deployment)

    def list_deployments(self, project_id: str, limit: int = 10) -> list[Deployment]:
        rows = sorted(
            self._deployments.get(project_id, {}).values(),
            key=lambda d: (d.created_at, d.id),
            reverse=True,
        )
        return copy.deepcopy(rows[:limit])

    def get_latest_deployment(self, project_id: str) -> Deployment | None:
        rows = self.list_deployments(project_id, limit=1)
        return rows[0] if rows else None

    def _find_deployment(self, deployment_id: str) -> Deployment | None:
        """By id rather than by (project_id, external_key). The attribution
        path only ever holds an id — it was handed a row, not a delivery."""
        for by_key in self._deployments.values():
            for row in by_key.values():
                if row.id == deployment_id:
                    return row
        return None

    def freeze_deployment_tasks(
        self, deployment_id: str, task_ids: list[str], now: datetime
    ) -> bool:
        # The same guard the Postgres function enforces, deliberately
        # duplicated rather than left to the production adapter's accident.
        # Every test in apps/cloud/tests/ runs against this class, so a guard
        # that lived only in SQL would be a contract no test could observe —
        # which is how the unfrozen behaviour survived a green suite in the
        # first place.
        row = self._find_deployment(deployment_id)
        if row is None or row.attribution_state == "frozen":
            return False
        self._deployment_tasks[deployment_id] = list(task_ids)
        row.attribution_state = "frozen"
        row.attributed_at = now
        return True

    def clear_deployment_attribution(self, deployment_id: str) -> bool:
        row = self._find_deployment(deployment_id)
        if row is None:
            return False
        row.attribution_state = "uncomputed"
        row.attributed_at = None
        return True

    def list_deployment_tasks(self, deployment_id: str) -> list[str]:
        return list(self._deployment_tasks.get(deployment_id, []))

    def list_stale_deployments(self, older_than: datetime, limit: int = 50) -> list[Deployment]:
        rows = [
            row
            for by_key in self._deployments.values()
            for row in by_key.values()
            if row.state not in ("live", "failed", "inactive") and row.updated_at < older_than
        ]
        rows.sort(key=lambda d: (d.updated_at, d.id))
        return copy.deepcopy(rows[:limit])

    def list_projects(self, user_id: str) -> list[Project]:
        member_ws = {
            ws_id for ws_id, members in self._members.items() if user_id in members
        }
        return [p for p in self._projects.values() if p.workspace_id in member_ws]

    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]:
        return [p for p in self._projects.values() if p.workspace_id == workspace_id]

    def list_assigned_tasks(
        self,
        user_id: str,
        workspace_id: str | None = None,
        statuses: list[TaskStatus] | None = None,
        limit: int = 200,
    ) -> list[AssignedTask]:
        wanted = set(statuses) if statuses else None
        out: list[AssignedTask] = []
        for project in self._projects.values():
            if workspace_id is not None and project.workspace_id != workspace_id:
                continue
            # Membership is re-checked here, not inherited from the assignment:
            # a removed member keeps their assigned_user_id on the row.
            if self.get_membership(project.workspace_id, user_id) is None:
                continue
            store = self._graph.get(project.id)
            if not store:
                continue
            workspace = self._workspaces.get(project.workspace_id)
            for task in store["tasks"].values():
                if task.assigned_user_id != user_id or task.deleted_at is not None:
                    continue
                if wanted is not None and task.status not in wanted:
                    continue
                out.append(
                    AssignedTask(
                        task=copy.deepcopy(task),
                        project_id=project.id,
                        project_name=project.name,
                        workspace_id=project.workspace_id,
                        workspace_name=workspace.name if workspace else "",
                        repo_url=project.repo_url,
                    )
                )
        out.sort(key=lambda a: (a.project_name, a.task.feature_tag or "", a.task.id))
        return out[:limit]

    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        out = [i for i in self._invitations.values() if i.workspace_id == workspace_id]
        if status is not None:
            out = [i for i in out if i.status == status]
        return out

    def list_invitations_for_email(
        self, email: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        target = email.strip().lower()
        out = [i for i in self._invitations.values() if i.email.strip().lower() == target]
        if status is not None:
            out = [i for i in out if i.status == status]
        return out

    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation:
        inv = next(
            (
                i
                for i in self._invitations.values()
                if i.id == invitation_id and i.workspace_id == workspace_id
            ),
            None,
        )
        if inv is None:
            raise KeyError("invitation_not_found")
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        inv.status = InvitationStatus.revoked
        return inv

    # -- graph ------------------------------------------------------------ #
    def _owning_project(self, etype: str, entity_id: str) -> str | None:
        """Which project holds this entity id, if any — the in-memory twin of the
        supabase adapter's by-id row lookup, so both refuse a cross-project id."""
        for owner_id, store in self._graph.items():
            if entity_id in store.get(etype, {}):
                return owner_id
        return None

    def upsert_graph(
        self,
        project_id: str,
        payload: GraphUpsertRequest,
        source: str = "pz",
        seed_fields: frozenset[str] = frozenset(),
    ) -> tuple[dict[str, int], dict[str, list[str]]]:
        store = self._graph[project_id]
        counts: dict[str, int] = {}
        conflicts: dict[str, list[str]] = {}
        now = utcnow()  # server owns the cursor timestamp
        # Pass 1: refuse the whole write if any id belongs to another project,
        # before a single row lands. The store is keyed by project here, so a
        # foreign id would otherwise read as "new" and be created as a second
        # row — where the supabase adapter, keyed by id alone, would have
        # rewritten the original. Neither is acceptable; both now raise.
        for etype in ENTITY_TYPES:
            for item in getattr(payload, etype):
                owner = self._owning_project(etype, item.id)
                if owner is not None and owner != project_id:
                    raise CrossProjectWrite(etype, item.id, owner)
        for etype, model in ENTITY_TYPES.items():
            items = getattr(payload, etype)
            if not items:
                continue
            authority = FIELD_AUTHORITY.get(etype, {})
            defaults = FIELD_DEFAULTS.get(etype, {})
            for item in items:
                stored = store[etype].get(item.id)
                stored_dict = stored.model_dump(mode="json") if stored else None
                merged, dropped = merge_entity(
                    stored_dict,
                    _incoming_dump(item),
                    authority,
                    source,
                    now,
                    defaults,
                    _unwritten_fields(item),
                    seed_fields,
                )
                store[etype][item.id] = model(**merged)
                if dropped:
                    conflicts[item.id] = dropped
            counts[etype] = len(items)
        # touch the project so its updated_at advances too
        if counts and (project := self._projects.get(project_id)):
            project.updated_at = now
        return counts, conflicts

    def get_graph(
        self,
        project_id: str,
        since: datetime | None = None,
        limit: int | None = None,
        after_ts: datetime | None = None,
        after_id: str | None = None,
    ) -> ProjectGraph:
        project = self._projects[project_id]
        store = self._graph[project_id]
        graph = ProjectGraph(project=project)

        # Gather candidates across all entity types, then order globally by
        # (updated_at, id) so a `limit` yields a stable keyset page.
        candidates: list[tuple[datetime, str, str, object]] = []
        for etype in ENTITY_TYPES:
            for entity in store[etype].values():
                if since is None:
                    if entity.deleted_at is not None:
                        continue  # bootstrap pull: hide dead rows
                elif entity.updated_at is None or entity.updated_at <= since:
                    continue  # incremental pull: unchanged rows (tombstones included)
                if entity.updated_at is None:
                    continue
                # Keyset lower bound (exclusive) for pagination continuation.
                if after_ts is not None:
                    if entity.updated_at < after_ts:
                        continue
                    if entity.updated_at == after_ts and (
                        after_id is None or entity.id <= after_id
                    ):
                        continue
                candidates.append((entity.updated_at, entity.id, etype, entity))

        candidates.sort(key=lambda c: (c[0], c[1]))
        truncated = limit is not None and len(candidates) > limit
        if limit is not None:
            candidates = candidates[:limit]

        rows_by_type: dict[str, list] = {etype: [] for etype in ENTITY_TYPES}
        last: tuple[datetime, str] | None = None
        for ts, eid, etype, entity in candidates:
            rows_by_type[etype].append(copy.deepcopy(entity))
            last = (ts, eid)
        for etype in ENTITY_TYPES:
            setattr(graph, etype, rows_by_type[etype])

        graph.cursor = last[0] if last else (after_ts if after_ts else since)
        if truncated and last:
            graph.next_id = last[1]
            graph.has_more = True
        return graph

    def changes_head(
        self, project_id: str, since: datetime | None = None
    ) -> tuple[datetime | None, dict[str, int]]:
        store = self._graph[project_id]
        counts: dict[str, int] = {}
        max_cursor: datetime | None = None
        for etype in ENTITY_TYPES:
            changed = 0
            for entity in store[etype].values():
                if entity.updated_at is None:
                    continue
                if max_cursor is None or entity.updated_at > max_cursor:
                    max_cursor = entity.updated_at
                if since is not None and entity.updated_at <= since:
                    continue
                if since is None and entity.deleted_at is not None:
                    continue
                changed += 1
            if changed:
                counts[etype] = changed
        return max_cursor, counts

    def get_task(self, project_id: str, task_id: str) -> Task | None:
        store = self._graph.get(project_id)
        if not store:
            return None
        task = store["tasks"].get(task_id)
        return copy.deepcopy(task) if task else None

    def assign_task(
        self, project_id: str, task_id: str, assigned_user_id: str | None, now: datetime
    ) -> Task:
        store = self._graph.get(project_id)
        task = store["tasks"].get(task_id) if store else None
        if task is None:
            raise KeyError(task_id)
        versions = dict(task.field_versions or {})
        versions["assigned_user_id"] = {"updated_at": now.isoformat(), "source": "pz"}
        task.assigned_user_id = assigned_user_id
        task.field_versions = versions
        task.updated_at = now
        return copy.deepcopy(task)

    def set_task_status(
        self, project_id: str, task_id: str, status: TaskStatus, now: datetime
    ) -> Task:
        store = self._graph.get(project_id)
        task = store["tasks"].get(task_id) if store else None
        if task is None:
            raise KeyError(task_id)
        versions = dict(task.field_versions or {})
        versions["status"] = {"updated_at": now.isoformat(), "source": "pz"}
        task.status = status
        task.field_versions = versions
        task.updated_at = now
        return copy.deepcopy(task)

    def upsert_task_artifact(
        self,
        project_id: str,
        task_id: str,
        uri: str,
        commit_sha: str | None,
        kind: ArtifactKind,
        now: datetime,
    ) -> Artifact:
        store = self._graph.setdefault(project_id, {e: {} for e in ENTITY_TYPES})
        if commit_sha is not None:
            for existing in store["artifacts"].values():
                if (
                    existing.task_id == task_id
                    and existing.commit_sha == commit_sha
                    and existing.deleted_at is None
                ):
                    return copy.deepcopy(existing)
        artifact = Artifact(
            project_id=project_id,
            task_id=task_id,
            kind=kind,
            uri=uri,
            commit_sha=commit_sha,
            updated_at=now,
        )
        store["artifacts"][artifact.id] = artifact
        return copy.deepcopy(artifact)

    def get_node(
        self, project_id: str, node_type: str, node_id: str
    ) -> GraphEntity | PullRequest | Document | None:
        if node_type == "pull_requests":
            pr = self._pull_requests.get(project_id, {}).get(node_id)
            return copy.deepcopy(pr) if pr else None
        if node_type == "documents":
            doc = self._documents.get(project_id, {}).get(node_id)
            return copy.deepcopy(doc) if doc else None
        if node_type == "stage_documents":
            for doc in self._stage_documents.get(project_id, {}).values():
                if doc.id == node_id:
                    return copy.deepcopy(doc)
            return None
        store = self._graph.get(project_id)
        if not store:
            return None
        node = store.get(node_type, {}).get(node_id)
        return copy.deepcopy(node) if node else None

    # -- external-tracker links (M5) -------------------------------------- #
    def upsert_task_link(self, link: TaskLink) -> TaskLink:
        self._task_links[(link.provider, link.account_key, link.external_key)] = link
        return link

    def get_task_link(self, task_id: str, provider: str) -> TaskLink | None:
        for link in self._task_links.values():
            if link.provider == provider and link.task_id == task_id:
                return link
        return None

    def find_task_link_by_key(
        self, provider: str, account_key: str, external_key: str
    ) -> TaskLink | None:
        return self._task_links.get((provider, account_key, external_key))

    # -- tracker account bindings (plan 0019) ------------------------------ #
    def upsert_workspace_integration(
        self, integration: WorkspaceIntegration
    ) -> WorkspaceIntegration:
        with self._workspace_integrations_lock:
            # Mirrors migration 0032's `unique (provider, account_key)`. Without
            # it the memory backend would happily let two workspaces claim one
            # Jira site and no test on this backend could observe the collision
            # the plan exists to make impossible.
            for (ws_id, provider), stored in self._workspace_integrations.items():
                if (
                    provider == integration.provider
                    and stored.account_key == integration.account_key
                    and ws_id != integration.workspace_id
                ):
                    raise TrackerAccountConflict(integration.provider, integration.account_key)
            key = (integration.workspace_id, integration.provider)
            self._workspace_integrations[key] = integration
            return integration

    def get_workspace_integration(
        self, workspace_id: str, provider: str
    ) -> WorkspaceIntegration | None:
        return self._workspace_integrations.get((workspace_id, provider))

    def find_workspace_integration_by_account(
        self, provider: str, account_key: str
    ) -> WorkspaceIntegration | None:
        if not account_key:
            # `''` is the pre-0032 backfill value on pz_task_links.account_key
            # and is forbidden on the integration row by a check constraint. Bail
            # here too rather than relying on no row happening to match.
            return None
        for (_ws_id, stored_provider), stored in self._workspace_integrations.items():
            if stored_provider == provider and stored.account_key == account_key:
                return stored
        return None

    # -- maintenance -------------------------------------------------------- #
    def purge_expired_tombstones(self, ttl_days: int) -> dict[str, int]:
        cutoff = utcnow() - timedelta(days=ttl_days)
        counts: dict[str, int] = {}
        for store in self._graph.values():
            for etype in ENTITY_TYPES:
                expired_ids = [
                    eid
                    for eid, entity in store[etype].items()
                    if entity.deleted_at is not None and entity.deleted_at <= cutoff
                ]
                for eid in expired_ids:
                    del store[etype][eid]
                    self.delete_rag_chunks_for_node(eid)  # M9: chunks die with the tombstone
                if expired_ids:
                    counts[etype] = counts.get(etype, 0) + len(expired_ids)
        return counts

    # -- RAG assistant v1 (M9) --------------------------------------------- #
    def get_model_connection(self, workspace_id: str) -> ModelConnection | None:
        return self._model_connections.get(workspace_id)

    def upsert_model_connection(
        self,
        *,
        workspace_id: str,
        provider: str,
        base_url: str,
        model: str,
        embed_model: str,
        embed_dim: int,
        secret_ref: str,
        daily_token_budget: int,
        created_by: str,
    ) -> ModelConnection:
        existing = self._model_connections.get(workspace_id)
        conn = ModelConnection(
            workspace_id=workspace_id,
            provider=provider,
            base_url=base_url,
            model=model,
            embed_model=embed_model,
            embed_dim=embed_dim,
            secret_ref=secret_ref,
            daily_token_budget=daily_token_budget,
            created_by=created_by,
            created_at=existing.created_at if existing else utcnow(),
            updated_at=utcnow(),
        )
        self._model_connections[workspace_id] = conn
        return conn

    def upsert_rag_chunks(
        self,
        workspace_id: str,
        project_id: str,
        node_type: str,
        node_id: str,
        chunks: list[str],
        embeddings: list[list[float]],
        embed_model: str = "",
        embed_dim: int = 0,
    ) -> None:
        project_store = self._rag_chunks.setdefault(project_id, {})
        project_store[node_id] = {
            idx: RagChunk(
                workspace_id=workspace_id,
                project_id=project_id,
                node_type=node_type,
                node_id=node_id,
                chunk_index=idx,
                content=content,
                embedding=embedding,
                embed_model=embed_model,
                embed_dim=embed_dim,
            )
            for idx, (content, embedding) in enumerate(zip(chunks, embeddings, strict=True))
        }

    def delete_rag_chunks_for_node(self, node_id: str) -> int:
        removed = 0
        for project_store in self._rag_chunks.values():
            popped = project_store.pop(node_id, None)
            if popped:
                removed += len(popped)
        return removed

    def get_project_embed_model(self, workspace_id: str, project_id: str) -> str | None:
        for chunks_by_index in self._rag_chunks.get(project_id, {}).values():
            for chunk in chunks_by_index.values():
                if chunk.workspace_id == workspace_id:
                    return chunk.embed_model
        return None

    def get_project_embed_dim(self, workspace_id: str, project_id: str) -> int | None:
        for chunks_by_index in self._rag_chunks.get(project_id, {}).values():
            for chunk in chunks_by_index.values():
                if chunk.workspace_id == workspace_id:
                    return chunk.embed_dim
        return None

    def count_project_rag_chunks(self, workspace_id: str, project_id: str) -> int:
        return sum(
            1
            for chunks_by_index in self._rag_chunks.get(project_id, {}).values()
            for chunk in chunks_by_index.values()
            if chunk.workspace_id == workspace_id
        )

    def vector_search(
        self,
        workspace_id: str,
        project_id: str,
        query_embedding: list[float],
        top_k: int = 8,
    ) -> list[RagChunkHit]:
        scored: list[tuple[float, RagChunk]] = []
        for chunk in self._rag_chunks.get(project_id, {}).values():
            for c in chunk.values():
                # Explicit workspace predicate before similarity (ADR 0011) —
                # a project_id collision across workspaces can't leak chunks.
                if c.workspace_id != workspace_id or c.project_id != project_id:
                    continue
                scored.append((_cosine(c.embedding, query_embedding), c))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [
            RagChunkHit(
                node_type=c.node_type,
                node_id=c.node_id,
                chunk_index=c.chunk_index,
                content=c.content,
                score=score,
            )
            for score, c in scored[:top_k]
        ]

    # -- Git-host integration (M11) ---------------------------------------- #
    def upsert_pull_request(self, pr: PullRequest) -> PullRequest:
        self._pull_requests.setdefault(pr.project_id, {})[pr.id] = pr
        return pr

    def upsert_code_chunks(
        self,
        workspace_id: str,
        project_id: str,
        repo: str,
        path: str,
        sha: str,
        line_ranges: list[tuple[int, int]],
        embeddings: list[list[float]],
    ) -> None:
        project_store = self._code_chunks.setdefault(project_id, {})
        project_store[(repo, path)] = {
            idx: CodeChunk(
                workspace_id=workspace_id,
                project_id=project_id,
                repo=repo,
                path=path,
                sha=sha,
                start_line=start,
                end_line=end,
                chunk_index=idx,
                embedding=embedding,
            )
            for idx, ((start, end), embedding) in enumerate(
                zip(line_ranges, embeddings, strict=True)
            )
        }

    def delete_code_chunks_for_path(self, project_id: str, repo: str, path: str) -> int:
        project_store = self._code_chunks.get(project_id, {})
        popped = project_store.pop((repo, path), None)
        return len(popped) if popped else 0

    def code_vector_search(
        self,
        workspace_id: str,
        project_id: str,
        query_embedding: list[float],
        top_k: int = 8,
    ) -> list[CodeChunkHit]:
        scored: list[tuple[float, CodeChunk]] = []
        for chunks_by_index in self._code_chunks.get(project_id, {}).values():
            for c in chunks_by_index.values():
                if c.workspace_id != workspace_id or c.project_id != project_id:
                    continue
                scored.append((_cosine(c.embedding, query_embedding), c))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [
            CodeChunkHit(
                repo=c.repo, path=c.path, sha=c.sha,
                start_line=c.start_line, end_line=c.end_line, score=score,
            )
            for score, c in scored[:top_k]
        ]

    # -- Documents knowledge base (M0) --------------------------------------- #
    def create_document(self, document: Document) -> Document:
        self._documents.setdefault(document.project_id, {})[document.id] = document
        return document

    def get_document(self, project_id: str, document_id: str) -> Document | None:
        doc = self._documents.get(project_id, {}).get(document_id)
        return copy.deepcopy(doc) if doc else None

    def list_documents(self, project_id: str) -> list[Document]:
        return list(self._documents.get(project_id, {}).values())

    def update_document_extraction(
        self,
        project_id: str,
        document_id: str,
        *,
        status: str,
        extract_method: str | None,
        extracted_text: str | None,
    ) -> Document:
        doc = self._documents[project_id][document_id]
        doc.status = status
        doc.extract_method = extract_method
        doc.extracted_text = extracted_text
        doc.updated_at = utcnow()
        return doc

    # -- Generation (M1) ------------------------------------------------------ #
    def get_latest_requirement(self, project_id: str) -> Requirement | None:
        store = self._graph.get(project_id, {})
        live = [r for r in store.get("requirements", {}).values() if r.deleted_at is None]
        if not live:
            return None
        return copy.deepcopy(max(live, key=lambda r: r.updated_at or utcnow()))

    def get_latest_spec_document(self, project_id: str) -> SpecDocument | None:
        store = self._graph.get(project_id, {})
        live = [s for s in store.get("spec_documents", {}).values() if s.deleted_at is None]
        if not live:
            return None
        return copy.deepcopy(max(live, key=lambda s: s.updated_at or utcnow()))

    def create_generation_run(self, run: GenerationRun) -> GenerationRun:
        self._generation_runs[run.id] = run
        return run

    def update_generation_run(
        self,
        run_id: str,
        *,
        status: str,
        prompt_tokens: int,
        completion_tokens: int,
    ) -> GenerationRun:
        run = self._generation_runs[run_id]
        run.status = status
        run.prompt_tokens = prompt_tokens
        run.completion_tokens = completion_tokens
        return run

    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None:
        doc = self._stage_documents.get(project_id, {}).get(stage)
        return copy.deepcopy(doc) if doc else None

    def upsert_stage_document(
        self, project_id: str, workspace_id: str, stage: str, content: str, user_id: str
    ) -> StageDocument:
        store = self._stage_documents.setdefault(project_id, {})
        existing = store.get(stage)
        doc = StageDocument(
            id=existing.id if existing else new_id(),
            workspace_id=workspace_id,
            project_id=project_id,
            stage=stage,
            content=content,
            created_by=existing.created_by if existing else user_id,
            updated_at=utcnow(),
        )
        store[stage] = doc
        return copy.deepcopy(doc)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
