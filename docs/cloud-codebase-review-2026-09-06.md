# Cloud codebase review

Reviewed: 2026-09-06. Baseline: `8cdf5eb`, including the working tree's existing edits. Review only; no implementation changes.

## Scope and evidence

Reviewed the API, repository implementations, generation and projection paths, RAG ingestion/reindexing, GitHub and tracker integrations, deployment state/reconciliation, document ingestion, startup wiring, relevant migrations, and tests. Findings below distinguish executable inconsistencies from maintainability recommendations; they are not a claim that every possible defect has been found.

Architecture references: [ADR 0010](decisions/0010-sync-model.md), [ADR 0020](decisions/0020-cloud-is-the-source-of-truth.md), [ADR 0022](decisions/0022-task-loop-closes-on-push.md), [ADR 0021](decisions/0021-deployment-templates-seeded-ci-cloud-observed.md), [ADR 0023](decisions/0023-development-preview-for-every-project-type.md), and [ADR 0024](decisions/0024-generated-deployment-scaffolds.md). ADRs 0020 and 0024 are marked **Proposed**; 0020 nevertheless describes the authority model explicitly asserted by the current sync module and referenced by accepted ADR 0022. Unimplemented proposals are not, by themselves, defects.

Existing edits were present in cloud deployment, sync, provider, schema, and test files. Findings describe those files as read, without attributing problems to a particular commit or author.

Validation: `apps/cloud/.venv/bin/pytest -q` from `apps/cloud` produced **558 passed, 1 failed**. The failure was `tests/test_deployments.py::test_probe_accepts_an_ordinary_public_host`, which depends on public DNS. An approved rerun of that single test outside the sandbox passed. No live Supabase database or external integration was exercised. Passing memory-backed tests do not validate the production adapter's semantics.

Priority: **High** means incorrect authority, data integrity, or a broken primary workflow; **Medium** means a functional inconsistency or substantial maintenance/reliability issue; **Low** means cleanup with limited immediate impact.

## Findings

### 1. Full-graph writes bypass the newer authoring and task permissions — High

**Files:** `apps/cloud/app/api/sync.py:593` (`push_graph`), `app/api/sync.py:508` (`assign_task`), `app/api/sync.py:545` (`set_task_status`), `app/api/_guards.py` (`require_stage_access`), `app/db/merge.py` (`incoming_dump`), all under `apps/cloud`.

**Evidence and concern:** `push_graph` checks only project membership, accepts the caller's `source`, and passes full graph entities to the repository. The dedicated status route forbids a member from setting `verified` or modifying another person's task; the full-graph route applies neither rule. Explicit `assigned_user_id` values also survive the special unset-field filter. Admin-only plan authoring can be bypassed by writing spec documents through graph sync. The module says cloud planning is authoritative but retains the old write surface without enforcing that boundary.

**Impact:** A member or stale client can overwrite planning fields, clear acceptance criteria through model defaults, change assignments, or set review status through a less restrictive endpoint.

**Recommendation:** Retire public planning/task graph mutation, or constrain a temporary compatibility endpoint to explicitly authorized operations. Derive the writer domain from the trusted integration path, rather than accepting a client-selected authority. Keep the field merge machinery only where independent tracker ownership still requires it. Add cross-endpoint authorization regression cases.

### 2. Supabase RLS does not enforce the same permissions as the API — High

**Files:** `apps/cloud/migrations/0003_auth_workspaces.sql:125`, `migrations/0006_grants.sql`, `app/api/_guards.py`, `app/api/sync.py`.

**Evidence and concern:** Graph-table policies permit all operations for project workspace members. Authenticated database grants expose those operations. API rules distinguish admin-only plan edits, task ownership, and admin verification, but the database policy does not. The guards' claim that RLS enforces the same rules a second time is therefore too strong.

**Impact:** In deployments exposing Supabase's authenticated data API, a member can bypass route-level restrictions by writing tables directly, even after finding 1 is fixed.

**Recommendation:** Decide whether clients may mutate graph tables directly. Either revoke those direct writes and use narrowly authorized server operations, or express the relevant restrictions in database policies/functions. Validate with real member/admin JWTs against Supabase.

### 3. Production graph pagination implements a different contract from memory — High

**Files:** `apps/cloud/app/db/supabase_repository.py:557`, `app/db/repository.py:836`, `app/models/schemas.py:590`, `tests/test_sync.py:140`.

**Evidence and concern:** Memory gathers entities globally, orders by `(updated_at, id)`, applies one limit, and sets `has_more`/`next_id`. Supabase applies the limit separately to each table, filters the ID continuation in Python after limiting, and never sets continuation metadata. A page filled with previously returned rows sharing a timestamp can become empty after that filtering. The maximum timestamp from another table can also advance beyond omitted rows.

**Impact:** Production clients can stop early, exceed the requested page size, or permanently skip entities. Existing pagination tests exercise the memory implementation.

**Recommendation:** Define one pagination contract and implement it in both adapters. Apply the complete exclusive keyset predicate before limiting, merge candidate rows globally, fetch enough to detect continuation, and return matching metadata. Run the same contract cases against both adapters, including equal timestamps and mixed entity types.

### 4. Assigned-task filtering happens after the production limit — Medium

**Files:** `apps/cloud/app/db/supabase_repository.py:415`, `app/db/repository.py` (`list_assigned_tasks`).

**Evidence and concern:** Supabase selects assigned tasks with `limit` before restricting projects to the requested workspace and before applying the advertised sort. Memory filters and sorts before limiting.

**Impact:** A user with tasks in several workspaces can receive an empty or incomplete list for one workspace because other workspaces consumed the limit. Returned subsets also differ between backends.

**Recommendation:** Scope the task query to eligible projects/workspaces and apply deterministic ordering before limiting. Add a multi-workspace case with more tasks than the limit.

### 5. Regeneration appends graph entities while manual saving updates them — High

**Files:** `apps/cloud/app/api/generation.py:495–532`, `app/generation/projection.py:66`, `app/integrations/task_refs.py`.

**Evidence and concern:** Every generated requirement, plan, and task gets a fresh model ID. Existing rows are neither reconciled nor retired. Manual stage saves instead update the latest requirement/spec. Regenerating the same checklist creates another set of `T001`, `T002`, etc., while old tasks and their assignments/statuses remain.

**Impact:** The single stage document diverges from a growing graph. Boards, lineage counts, and commit-reference attribution can include obsolete or ambiguous tasks. Regeneration is not a safe way to synchronize a hand-edited task document.

**Recommendation:** Use one stage application service for generated and edited content. Give task references stable identity within a project or explicit plan revision, reconcile existing tasks, and define how removed tasks are retired while preserving evidence and work already performed.

### 6. Stage documents and their projections have no explicit consistency state — Medium

**Files:** `apps/cloud/app/api/stage_documents.py:61`, `app/generation/projection.py`, `app/api/generation.py:249–310`.

**Evidence and concern:** Manual task edits never project to the board; clearing a stage document leaves its graph entity intact; existing specification edits update only the requirement title. Projection errors are logged but the save response exposes no projection failure. Generation has a separate persistence path and a different partial-success response (`saved`).

**Impact:** Saved text, downstream stage prerequisites, graph context, and board contents can disagree without an API-visible explanation. Preserving drafts on failure is useful, but silently treating the projection as current is not.

**Recommendation:** Explicitly identify the canonical document/revision and report whether its projection is current, pending, or failed. Share application logic across save/generate. Decide whether task editing is a draft operation requiring an explicit apply action; do not imply it has already updated the board.

### 7. RAG indexing depends on which route performed a graph write — Medium

**Files:** `apps/cloud/app/api/generation.py:275–293,495–532`, `app/api/stage_documents.py:76–94`, `app/api/sync.py` (`push_graph`, `set_task_status`).

**Evidence and concern:** Generation enqueues the stage document but not the requirement/spec/tasks it persists. Manual projection explicitly enqueues its graph entity. Full-graph sync enqueues graph entities, while the dedicated task-status route does not refresh the task's embedding.

**Impact:** Equivalent graph changes produce different search freshness. A full reindex later changes retrieval behavior without any content edit, obscuring the original missing event.

**Recommendation:** Centralize graph-change notification in a small application service shared by write paths, producing indexing jobs for affected nodes. Avoid requiring every router to remember the same side effects independently.

### 8. Repository-creation retries replace the stored signing secret without updating GitHub — High

**Files:** `apps/cloud/app/api/sync.py:302–339`, `app/integrations/github.py:471–497,308–330,928–952`, `tests/test_lifecycle.py:264`.

**Evidence and concern:** Each attempt generates a new webhook secret. `create_repo_webhook` treats a 422 response as success. `ensure_hook_events` changes only event subscriptions, deliberately leaving the existing remote secret unchanged. The route nevertheless stores the newly generated secret in the local binding.

**Impact:** Retrying a partially completed setup with an existing hook can make all subsequent signed deliveries fail verification. The current fake records another hook instead of faithfully modeling the existing-hook case.

**Recommendation:** Reuse the persisted secret for retries, or explicitly update the remote hook and local binding through a recoverable rotation flow. Distinguish a known duplicate-hook response from other 422 errors. Test retries against a fake that preserves the original hook configuration.

### 9. Any accessible repository with the requested name can be adopted as a retry — High

**Files:** `apps/cloud/app/api/sync.py:245–273` (`RepoAlreadyExistsError` handler), `app/integrations/github.py` (`create_commit_with_files`).

**Evidence and concern:** On a name conflict, the route adopts any repository returned by `get_repo`. It does not require a persisted provisioning record or verify that this project created the repository. The project-specific description is written on creation but is not checked on adoption.

**Impact:** A name collision with an unrelated, accessible repository can lead to seeding project files, deployment secrets, and a webhook into that repository. This is materially different from recovering a previous attempt.

**Recommendation:** Persist a project-to-repository provisioning identity as soon as creation succeeds and only auto-adopt that known repository. For an unrelated collision, return a conflict rather than guessing ownership from the name.

### 10. Provisioning can overwrite deployment state already observed from the webhook — Medium

**Files:** `apps/cloud/app/api/sync.py:302–400`, `app/api/github.py:284`, `app/deployments/state.py`.

**Evidence and concern:** The hook binding intentionally exists before the seed commit. After the commit call completes, provisioning unconditionally writes `awaiting_first_deploy`. A delivery handled while the route is awaiting GitHub can already have written a newer deployment view.

**Impact:** A queued/building/live observation can be overwritten by the initial placeholder. If no later delivery arrives, the displayed status remains stale despite a recorded deployment.

**Recommendation:** Initialize state before triggering the workflow, or conditionally initialize only when no observed deployment exists. Recompute the view from deployment records after provisioning rather than overwriting observed state.

### 11. “Last-known-good” preview retention is limited to ten rows — Medium

**Files:** `apps/cloud/app/deployments/state.py:28–53`.

**Evidence and concern:** `refresh_deployment_state` promises that failures do not blank a working preview, but searches only the latest ten deployments for a live URL.

**Impact:** Ten subsequent failed/in-flight deployments erase a still-working preview link from the project view.

**Recommendation:** Query the latest successful deployment independently of the display-history limit, or retain an explicit last-successful reference. Test a successful deployment followed by more than ten failures.

### 12. Frozen build attribution is recalculated and replaced on repeated terminal deliveries — Medium

**Files:** `apps/cloud/app/api/github.py:325–329`, `app/deployments/attribution.py:65–99`, `app/db/supabase_repository.py:370`, `app/db/repository.py` (`set_deployment_tasks`).

**Evidence and concern:** Every applicable terminal delivery reruns attribution against current Git and graph state. There is no persisted “already frozen” check; Supabase deletes the current task set and inserts the newly computed one in separate calls.

**Impact:** A redelivery after task/artifact changes or a temporary GitHub failure can rewrite the historical task set. A failed insert after deletion can also erase it. This contradicts the module's explicit immutable-review-history rationale.

**Recommendation:** Persist an explicit attribution state so an empty completed result differs from an uncomputed result. Freeze once with an atomic operation; expose deliberate correction/retry separately if incomplete attribution must be repairable.

### 13. Reindex does not cover all sources that ingestion indexes — Medium

**Files:** `apps/cloud/app/rag/backfill.py:45–78`, `app/api/assistant.py:159–177`, `app/rag/queue.py:260`, `app/db/supabase_repository.py` (`upsert_code_chunks`).

**Evidence and concern:** Backfill explicitly skips pull requests and has no code-file sweep. Connecting/changing a model calls this partial backfill. Normal document jobs fall back to managed embeddings, while code jobs require a BYO connection. Code chunks also lack the model provenance used to detect incompatible text-chunk embeddings.

**Impact:** PR/code jobs dropped before configuration cannot be recovered through “reindex everything.” Model changes can leave code embeddings stale or incompatible with query embeddings, and managed workspaces get different source coverage.

**Recommendation:** Define the supported source set once for ingestion, reindex, and status reporting. Add bounded PR/code backfill and model provenance where those sources are supported. Share embedding-connection resolution; if managed code indexing is intentionally excluded, expose that limitation explicitly.

### 14. Tracker provider abstraction exposes an unusable ClickUp integration — Medium

**Files:** `apps/cloud/app/integrations/clickup.py`, `app/integrations/registry.py`, `app/api/integrations.py:40–72`.

**Evidence and concern:** ClickUp is registered and configurable, but `_outbound_auth` only supplies Jira credentials and `_webhook_secret` only supplies Jira's signing secret. ClickUp outbound calls therefore fail with missing credentials and inbound verification always receives an empty secret.

**Impact:** The provider catalog promises functionality the runtime cannot execute. A second adapter currently demonstrates parsing extensibility without delivering a working second integration.

**Recommendation:** Hide or explicitly mark ClickUp unavailable until its credential path exists, or complete that path. Keep provider capabilities and credential resolution together so adding a registry entry cannot imply unsupported operations.

### 15. “Mirror” always creates a new external issue — Medium

**Files:** `apps/cloud/app/api/integrations.py:101–151`, `app/integrations/jira.py` (`build_push`), `app/integrations/clickup.py:33`, `app/db/supabase_repository.py:760`.

**Evidence and concern:** `mirror_task` does not read the existing task link before calling the adapter's create request. The new result replaces the stored link.

**Impact:** Repeated clicks or retries create duplicate external issues and orphan the previous linkage, rather than synchronizing the existing issue.

**Recommendation:** Use the existing link to distinguish create from update. Make retry behavior explicit; at minimum return the existing link when mirroring an already-linked task if updating is not implemented.

### 16. Tracker identity is scoped by provider, not by provider account/workspace — High

**Files:** `apps/cloud/app/api/integrations.py:188–243`, `app/db/supabase_repository.py:772`, `app/db/repository.py` (`find_task_link_by_key`), `migrations/0005_tracker_links.sql`.

**Evidence and concern:** Inbound routing looks up only `(provider, external_key)` and takes the first match. Jira issue keys can repeat across independently configured sites. Mirrored discussion IDs similarly use only provider and comment ID, without the site or project identity. The webhook secret is global rather than an account-specific routing credential.

**Impact:** If multiple tracker sites share the integration, a legitimate delivery can update the wrong project's linkage/comment. Existing project isolation tests do not establish safety for colliding site-local identifiers.

**Recommendation:** Bind each inbound webhook to a verified integration/account identity and include that identity in link lookup and deterministic comment IDs. Enforce matching uniqueness constraints and test two sites with identical issue/comment identifiers.

### 17. Field ownership has a first-write exception and does not provide atomic concurrent merging — Medium

**Files:** `apps/cloud/app/db/merge.py:86–132`, `app/db/supabase_repository.py:524–550,640–672`.

**Evidence and concern:** A new entity is accepted wholesale, including fields outside the writer's ownership; only the version stamps are filtered. Existing entities use a read/merge/write sequence without a version predicate or transaction. Dedicated assignment/status writes also read and replace the version map.

**Impact:** Ownership differs between insert and update. Two requests can read the same row, each merge correctly in isolation, and then overwrite each other's changes/version metadata. The comments overstate protection against concurrent edits.

**Recommendation:** Enforce writable fields on creation as well as updates. For the remaining multi-writer tracker boundary, use atomic field updates or optimistic concurrency with a retry. Simplify ordinary cloud-authored updates instead of routing them through a generalized merge engine.

### 18. Generation runs can remain running after transport or persistence failures — Medium

**Files:** `apps/cloud/app/api/generation.py:186–321`.

**Evidence and concern:** The streaming wrapper marks failures for `HTTPStatusError` and `GenerationError`, but connection/timeouts, cancellation, and repository failures outside the limited catches have no terminal run update. Token accounting occurs only after the complete provider stream.

**Impact:** Failed or disconnected generation can leave misleading running audit records and omit partial usage. Stream clients may receive an abrupt termination without a structured error.

**Recommendation:** Give each run one explicit terminal-state lifecycle, including transport failures and cancellation. Preserve partial drafts deliberately and record available usage. Keep the error handling around the full operation rather than adding unrelated catches at individual writes.

### 19. Async request/worker paths directly perform synchronous database and storage I/O — Medium

**Files:** `apps/cloud/app/db/supabase_repository.py`, `app/api/generation.py`, `app/api/documents.py`, `app/api/github.py`, `app/rag/queue.py`, `app/main.py`.

**Evidence and concern:** The Supabase repository is synchronous. Async routes and background loops invoke its `.execute()` operations directly; upload also invokes synchronous document storage. Declaring the surrounding function async does not move those calls off the event loop.

**Impact:** Slow production I/O can stall unrelated SSE responses, presence, and queue progress on the same worker. Memory tests conceal that cost.

**Recommendation:** Choose a consistent I/O boundary: an async repository/storage client, or bounded thread offloading for synchronous operations from async callers. Keep ordinary synchronous FastAPI routes synchronous where appropriate. Avoid a broad repository redesign solely for naming consistency.

### 20. Deployment orchestration crosses the router/service boundary — Low

**Files:** `apps/cloud/app/api/sync.py` (`create_repository`, `_resolve_deployment_provisioning`, `_resolve_var`), `app/deployments/reconcile.py:96`, `app/api/github.py:237`, `app/deployments/attribution.py:28`.

**Evidence and concern:** The sync router owns a long external provisioning workflow and an untyped provisioning dictionary. Reconciliation imports the router's private `_trusted_environment_url`. Attribution and reconciliation duplicate `_repo_full_name`.

**Impact:** Transport registration and domain workflows become coupled; retry, URL policy, and credential changes require coordinated edits across unrelated API modules. This is a concrete boundary issue, not merely a file-length complaint.

**Recommendation:** Extract a small provisioning service with a typed result and shared deployment/GitHub URL helpers. Keep HTTP permission checks and response mapping in routers. Reuse the existing provider/template registries; a new generic workflow framework would add unnecessary complexity.

### 21. Deferred abstractions and historical comments obscure the supported product — Low

**Files:** `apps/cloud/app/documents/sources.py`, `app/api/documents.py:65–66`, `app/generation/routing.py`, `app/documents/ocr.py`, `app/main.py`, `apps/cloud/README.md`, `migrations/0015_stage_model_routing.sql`.

**Evidence and concern:** The upload path wraps bytes in `UploadSource` and awaits a method that simply returns the same bytes; no consumer requires the `DocumentSource` protocol. `select_model` only returns its argument, while its docstring directs developers to the old local planning path. A stage-routing table remains without application consumers. The README still describes local-authoritative sync, fixed 1536-dimensional embeddings, and old desktop authoring. OCR refers to a future managed tier, although the tier exists and startup still wires no real OCR provider.

**Impact:** Readers cannot readily distinguish active contracts, historical migrations, deferred functionality, and obsolete architecture. Scanned PDFs predictably fail extraction through the stub despite the surrounding managed-model infrastructure.

**Recommendation:** Pass uploaded bytes directly until a second source requires an abstraction. Remove the identity selection wrapper or give it a real policy role. Update operational documentation and mark OCR availability accurately. Preserve historical migrations; retire unused live schema through an explicit forward migration only after confirming no external consumers. Move historical implementation narratives out of routine code comments where they no longer explain current constraints.

### 22. Tests establish memory behavior more strongly than production contracts — Medium

**Files:** `apps/cloud/tests/conftest.py`, `tests/test_sync.py:140`, `tests/test_deployments.py:463–467`, `tests/test_lifecycle.py:264`, `app/integrations/github.py` (`FakeGithubClient`).

**Evidence and concern:** The common fixture forces memory storage/stub auth. Production pagination and query-order differences therefore pass the suite. The webhook fake does not reproduce remote duplicate registration semantics. One ordinary unit test requires actual public DNS, despite the suite's hermetic setup intent; it failed in the sandbox and passed outside it.

**Impact:** Green tests can coexist with adapter-specific data loss and retry defects, while restricted/offline environments produce unrelated failures.

**Recommendation:** Add a focused shared repository contract suite against memory and a disposable Supabase instance, prioritizing pagination, membership, concurrent updates, and task filtering. Model webhook retries accurately in fakes. Stub DNS answers in unit tests and keep real resolver checks in an explicitly marked integration suite.

## Suggested order of work

1. Close authority/permission bypasses at both API and database boundaries (1–2), then fix production pagination and task filtering (3–4).
2. Make generation application stable and projection/indexing state explicit (5–7).
3. Make repository provisioning retries safe before further expanding templates (8–10).
4. Correct historical deployment state and attribution, then RAG/tracker identity and recovery (11–17).
5. Improve run failure handling, async I/O boundaries, small service extractions, and documentation (18–21), adding targeted contract coverage throughout (22).

## Deliberate choices not treated as defects

The in-process queue, presence, rate limiter, and token budget are documented single-instance trade-offs; this review does not recommend introducing Redis merely because those components exist. The no-source-code-at-rest code index, separate chat/embedding connections, and fixed hand-authored deployment workflows have explicit architectural reasons. Keeping generated drafts after projection failure is also useful; the missing piece is an honest consistency contract, not discarding the draft. Existing HTTP transport reuse and provider/template registries should be retained where they remove real duplication.
