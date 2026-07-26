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
from datetime import datetime, timedelta

from app.db.merge import incoming_dump as _incoming_dump
from app.db.merge import merge_entity
from app.models.schemas import (
    ENTITY_TYPES,
    FIELD_AUTHORITY,
    CodeChunk,
    CodeChunkHit,
    Document,
    GenerationRun,
    GraphEntity,
    GraphUpsertRequest,
    Invitation,
    InvitationStatus,
    ModelConnection,
    Project,
    ProjectGraph,
    PullRequest,
    RagChunk,
    RagChunkHit,
    Requirement,
    Role,
    SpecDocument,
    StageDocument,
    Task,
    TaskLink,
    Workspace,
    WorkspaceMember,
    new_id,
    utcnow,
)


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
    def find_workspace_by_github_repo(self, repo: str) -> Workspace | None:
        """Resolve an inbound GitHub webhook (no caller identity, just a
        `repository.full_name`) to the workspace whose install config names
        this repo (M11). v1 keeps this a one-repo-per-workspace mapping —
        see app/api/github.py."""

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
    def create_project(self, workspace_id: str, created_by: str, name: str) -> Project: ...

    @abc.abstractmethod
    def get_project(self, project_id: str) -> Project | None: ...

    @abc.abstractmethod
    def list_projects(self, user_id: str) -> list[Project]:
        """Projects across every workspace the user is a member of."""

    @abc.abstractmethod
    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]: ...

    @abc.abstractmethod
    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project: ...

    @abc.abstractmethod
    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]: ...

    @abc.abstractmethod
    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation: ...

    @abc.abstractmethod
    def upsert_graph(
        self, project_id: str, payload: GraphUpsertRequest, source: str = "pz"
    ) -> tuple[dict[str, int], dict[str, list[str]]]: ...

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
        `limit` + (`after_ts`,`after_id`) give keyset pagination ordered by
        (updated_at, id)."""

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
    def find_task_link_by_key(self, provider: str, external_key: str) -> TaskLink | None:
        """Resolve an inbound webhook's external key to a PromptConnext task."""

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
        incompatible vector dimensions in the same fixed-width column."""

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
        # (provider, external_key) -> TaskLink
        self._task_links: dict[tuple[str, str], TaskLink] = {}
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

    def find_workspace_by_github_repo(self, repo: str) -> Workspace | None:
        for ws in self._workspaces.values():
            if (ws.integration_config or {}).get("github", {}).get("repo") == repo:
                return ws
        return None

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
    def create_project(self, workspace_id: str, created_by: str, name: str) -> Project:
        project = Project(name=name, workspace_id=workspace_id, owner_id=created_by)
        self._projects[project.id] = project
        self._graph[project.id] = {etype: {} for etype in ENTITY_TYPES}
        return project

    def get_project(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(update={"lifecycle_status": status, "updated_at": utcnow()})
        self._projects[project_id] = updated
        return updated

    def list_projects(self, user_id: str) -> list[Project]:
        member_ws = {
            ws_id for ws_id, members in self._members.items() if user_id in members
        }
        return [p for p in self._projects.values() if p.workspace_id in member_ws]

    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]:
        return [p for p in self._projects.values() if p.workspace_id == workspace_id]

    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        out = [i for i in self._invitations.values() if i.workspace_id == workspace_id]
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
    def upsert_graph(
        self, project_id: str, payload: GraphUpsertRequest, source: str = "pz"
    ) -> tuple[dict[str, int], dict[str, list[str]]]:
        store = self._graph[project_id]
        counts: dict[str, int] = {}
        conflicts: dict[str, list[str]] = {}
        now = utcnow()  # server owns the cursor timestamp
        for etype, model in ENTITY_TYPES.items():
            items = getattr(payload, etype)
            if not items:
                continue
            authority = FIELD_AUTHORITY.get(etype, {})
            for item in items:
                stored = store[etype].get(item.id)
                stored_dict = stored.model_dump(mode="json") if stored else None
                merged, dropped = merge_entity(
                    stored_dict, _incoming_dump(item), authority, source, now
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

    def get_node(
        self, project_id: str, node_type: str, node_id: str
    ) -> GraphEntity | PullRequest | Document | None:
        if node_type == "pull_requests":
            pr = self._pull_requests.get(project_id, {}).get(node_id)
            return copy.deepcopy(pr) if pr else None
        if node_type == "documents":
            doc = self._documents.get(project_id, {}).get(node_id)
            return copy.deepcopy(doc) if doc else None
        store = self._graph.get(project_id)
        if not store:
            return None
        node = store.get(node_type, {}).get(node_id)
        return copy.deepcopy(node) if node else None

    # -- external-tracker links (M5) -------------------------------------- #
    def upsert_task_link(self, link: TaskLink) -> TaskLink:
        self._task_links[(link.provider, link.external_key)] = link
        return link

    def get_task_link(self, task_id: str, provider: str) -> TaskLink | None:
        for link in self._task_links.values():
            if link.provider == provider and link.task_id == task_id:
                return link
        return None

    def find_task_link_by_key(self, provider: str, external_key: str) -> TaskLink | None:
        return self._task_links.get((provider, external_key))

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
