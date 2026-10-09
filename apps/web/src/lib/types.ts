// Mirrors apps/cloud/app/models/schemas.py. Keep field-for-field in sync with
// the backend models — this is a read-only client, not an independent schema.

export type RequirementStatus = "draft" | "approved";
export type SpecStatus = "draft" | "approved";
export type TaskStatus = "todo" | "in_progress" | "implemented" | "verified";
export type ArtifactKind = "code" | "doc" | "test" | "other";
export type AgentRunStatus = "running" | "succeeded" | "failed";
export type Role = "admin" | "member";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Workspace {
  id: string;
  name: string;
  created_by: string;
  git_config: Record<string, unknown>;
  integration_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  email: string | null;
  role: Role;
  invited_by: string | null;
  created_at: string;
}

// Selected compliance/policy templates (plus free-text) shaping the project's
// generated documents. `selected` holds built-in template IDs (order
// preserved); "Custom" is not an ID — it lives in `custom_text`.
export interface PolicyScope {
  selected: string[];
  custom_text: string;
}

export interface Project {
  id: string;
  name: string;
  workspace_id: string;
  owner_id: string;
  onboarding_state: string;
  stage_state: Record<string, string>;
  lifecycle_status: "planning" | "pending_tech_review" | "tech_review" | "repo_created";
  repo_url: string | null;
  repo_default_branch: string | null;
  // Plan 0027. Server-recorded: "imported" by POST /projects, "created" by
  // create-repository. null for a project with no repository yet, or one
  // that predates the field.
  repo_origin?: "imported" | "created" | null;
  policy_scope?: PolicyScope | null;
  // ADR 0021. `deployment_config` is the Tech Lead's frozen input;
  // `deployment_state` is the server's current view, written only by the
  // signed GitHub webhook. Two fields, not one, because they have different
  // writers and different lifetimes.
  deployment_config?: DeploymentConfig | null;
  deployment_state?: DeploymentState | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentConfig {
  template_id: string;
  // ADR 0025. Provider identifiers naming the resource THIS project deploys
  // to — a Vercel project, a name and port on a Docker host. Keyed by
  // CredentialField name, and only
  // ever fields the provider declares `scope: "project"`; the token and the
  // account identifiers stay on the workspace credential.
  provider_values?: Record<string, string>;
}

// The denormalized current deployment view carried on every Project, so the
// workspace project list can show a "Live" pill without an extra request per
// project. `url` is LAST KNOWN GOOD while `state` is current — a failed
// deploy must not blank a preview that is still serving.
export interface DeploymentState {
  template_id: string | null;
  provider: string | null;
  state:
    | "not_configured"
    | "awaiting_first_deploy"
    | "queued"
    | "building"
    | "live"
    | "failed"
    | "inactive";
  url: string | null;
  commit_sha: string | null;
  run_url: string | null;
  updated_at: string;
}

export interface AcceptanceCriterion {
  text: string;
}

export interface Requirement {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface SpecDocument {
  id: string;
  project_id: string;
  requirement_id: string;
  content: string;
  version: number;
  status: SpecStatus;
  approved_by: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface Task {
  id: string;
  project_id: string;
  spec_id: string | null;
  title: string;
  status: TaskStatus;
  feature_tag: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  assignee: string | null;
  sprint: string | null;
  assigned_user_id: string | null;
  change_id: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  project_id: string;
  task_id: string;
  kind: ArtifactKind;
  uri: string;
  commit_sha: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  project_id: string;
  task_id: string;
  model_role: string;
  action: string;
  status: AgentRunStatus;
  evidence: Record<string, unknown>;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export type DiscussionSource = "pz" | "pmo";

export interface Discussion {
  id: string;
  project_id: string;
  parent_node_type: string;
  parent_node_id: string;
  author: string;
  body: string;
  source: DiscussionSource;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface ProjectGraph {
  project: Project;
  requirements: Requirement[];
  spec_documents: SpecDocument[];
  tasks: Task[];
  artifacts: Artifact[];
  agent_runs: AgentRun[];
  discussions: Discussion[];
  cursor: string | null;
  next_id: string | null;
  has_more: boolean;
}

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  token: string;
  status: InvitationStatus;
  invited_by: string;
  expires_at: string;
  created_at: string;
}

// An invitation addressed to the signed-in user (GET /invitations/pending).
// Carries the workspace name because the invitee is not a member yet and so
// cannot read the workspace row directly.
export interface PendingInvitation {
  token: string;
  workspace_id: string;
  workspace_name: string;
  role: Role;
  invited_by: string;
  expires_at: string;
}

// Non-secret view of a workspace's GitHub credential
// (GET/PUT /workspaces/{id}/integrations/github). Never carries the token.
export interface GithubConnection {
  connected: boolean;
  owner: string | null;
  owner_type: string | null;
  account_login: string | null;
  token_expires_at: string | null;
  connected_at: string | null;
}

// One repository the workspace's PAT can see
// (GET /workspaces/{id}/integrations/github/repos), for the import gate.
export interface GithubRepo {
  full_name: string;
  name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  // GitHub has no "has no commits" flag; this is size === 0. A repo in this
  // state can't be seeded — the seed step reads the branch head first, which
  // 404s — so the picker disables the row instead of failing at tech-review
  // exit.
  empty: boolean;
  pushed_at: string | null;
  // The project that already imported this repository. Both fields are null
  // when it belongs to a workspace the caller is not in: taken, but not named.
  imported_by: { project_id: string | null; name: string | null } | null;
}

// owner/owner_type/account_login are present even when repositories is
// empty: that emptiness is the out-of-scope-owner state the import gate has
// to explain (the user's repo lives under an account the connected PAT
// can't reach), and the connection-status endpoint that would otherwise
// supply the owner is admin-only, so a member reads it here instead.
export interface GithubRepoList {
  owner: string | null;
  owner_type: string | null;
  account_login: string | null;
  repositories: GithubRepo[];
  truncated: boolean;
}

// Assistant model status (apps/cloud/app/api/assistant.py). `configured` is
// about this workspace's own connection; the two `*_source` fields are what
// the assistant would actually resolve, which is what the UI reports — with
// no managed tier on the deployment, "none" means the assistant is mute.
export interface ModelConnectionStatus {
  configured: boolean;
  connection: {
    provider: string;
    base_url: string;
    model: string;
    embed_model: string;
    embed_dim: number;
    daily_token_budget: number;
    updated_at: string;
  } | null;
  chat_source: "byo" | "managed" | "none";
  embed_source: "byo" | "managed" | "none";
}

// RAG assistant (apps/cloud/app/api/assistant.py, ADR 0011).
//
// One Citation type covers all three retrieval kinds, discriminated by
// `source` (schemas.py:610). "vector" is a retrieved embedding chunk;
// "graph" is a whole-node reference from the exact lineage walk, where
// chunk_index is meaningless and always 0; "code" is a fetch-on-demand code
// chunk, and repo/path/start_line/end_line are set only for that kind — the
// code text itself is never persisted (ADR 0011: no source at rest).
export type CitationSource = "vector" | "graph" | "code";

export interface Citation {
  node_type: string;
  node_id: string;
  chunk_index: number;
  source: CitationSource;
  repo: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
}

// Emitted by app/api/assistant.py when a content question's retrieval
// produced nothing, so the panel can distinguish "not in your documents"
// from "your documents were never searched".
export type RetrievalGap = "no_embed_model" | "no_indexed_content";

export interface RetrievalNotice {
  grounded: boolean;
  reason: RetrievalGap | null;
}

export interface LineageAgentRun {
  id: string;
  status: AgentRunStatus;
}

// Computed by a graph walk (app/rag/lineage.py), not generated by a model —
// which is why the panel renders it as its own card rather than as prose.
// Which fields are populated depends on `scope`, so zero values are
// "not applicable here", not "none of them".
export interface LineageFacts {
  scope: "requirement" | "task" | "project";
  node_type: string | null;
  node_id: string | null;
  title: string;
  status: string | null;
  specs_total: number;
  tasks_total: number;
  tasks_done: number;
  task_status_counts: Record<string, number>;
  artifacts_total: number;
  agent_runs: LineageAgentRun[];
}

export interface InvitationCreateResponse {
  invitation: Invitation;
  accept_url: string;
  email_sent: boolean;
}

export type StageKind = "constitution" | "specify" | "plan" | "tasks";

export interface DocumentOut {
  id: string;
  project_id: string;
  title: string;
  mime: string;
  source_kind: string;
  extract_method: string | null;
  status: "pending" | "extracted" | "failed";
  created_at: string;
  updated_at: string;
}

/** How faithfully the project graph reflects the saved stage document
 *  (apps/cloud/app/generation/stage_apply.py::ProjectionState). Both write
 *  paths — generation and a manual save — report it in this one vocabulary:
 *  "current" means the board was updated from this document, "failed" means the
 *  document was saved but the graph was left alone, "not_applicable" means the
 *  stage has no graph entity of its own (the project rules), and "pending" is
 *  reserved for a stage that grows an explicit apply step. */
export type ProjectionState = "current" | "pending" | "failed" | "not_applicable";

/** `tasks` for an imported repository named files that are not in it and not
 *  marked `(new)` (apps/cloud/app/generation/path_check.py). */
export interface GenerationWarning {
  code: "unmarked_new_paths";
  items: { ref: string; path: string }[];
}

export interface GenerateDoneEvent {
  stage: StageKind;
  title: string;
  content: string;
  requirement_id?: string;
  spec_document_id?: string;
  task_count?: number;
  // Tasks this generation tombstoned — dropped from the checklist, or an
  // existing duplicate reference this generation consolidated. `tasks` only.
  retired_count?: number;
  // The model stopped at its output limit — the document is real but cut off.
  truncated?: boolean;
  // Notices on a generation that succeeded (an imported project's `tasks` only
  // today). Absent when there is nothing to say.
  warnings?: GenerationWarning[];
  // Whether the raw markdown was written to the stage-document side store,
  // i.e. whether it will still be there on the next visit to the project.
  saved?: boolean;
  updated_at?: string;
  // Only ever "current" or "not_applicable" here: a "failed" projection
  // never reaches a `done` event (apps/cloud/app/api/generation.py sends a
  // GenerateErrorEvent instead), and "pending" has no producer yet.
  projection?: ProjectionState;
}

export interface GenerateErrorEvent {
  error: string;
  retryable?: boolean;
  // Set on a post-generation failure (unparseable document): the model's
  // output was kept as a draft even though nothing landed in the graph.
  draft_saved?: boolean;
  truncated?: boolean;
}

// A drafted intake form: only the fields the model could answer from the
// project's source material, plus what it read them out of.
export interface PrefillOut {
  fields: Record<string, string>;
  sources: string[];
}

export interface StageDocumentOut {
  // null until a document has been saved for this stage.
  id: string | null;
  stage: StageKind;
  content: string;
  updated_at: string | null;
}

/** The Planner form answers behind a stage (GET/PUT
 *  /projects/{id}/stage-inputs/{stage}), shared by the project's members.
 *  `inputs` is empty until someone saves. */
export interface StageInputsOut {
  stage: StageKind;
  inputs: Record<string, string>;
  updated_at: string | null;
  updated_by: string | null;
}

/** A save knows something a read cannot: whether the graph now reflects the
 *  document (PATCH only, apps/cloud/app/api/stage_documents.py). */
export interface StageDocumentSaved extends StageDocumentOut {
  projection: ProjectionState;
  // Why `projection` is "failed", in the server's own error vocabulary.
  error?: string | null;
  // Tasks this save tombstoned — dropped from the checklist, or an existing
  // duplicate reference this save consolidated. `tasks` only.
  retired_count?: number | null;
}

// Plan 0027: the read of an imported repository the Plan and Tasks stages
// are written against (apps/cloud/app/models/schemas.py::RepoSnapshot).
export interface RepoStack {
  // "node" | "python" | "go", another language name, or null when nothing
  // recognisable was found.
  runtime: string | null;
  manifests: string[];
  languages: string[];
}

export interface RepoExcerpt {
  path: string;
  content: string;
  truncated: boolean;
}

// A path the analysis left out: a vendored or build directory (one entry,
// ending in "/"), a binary file, or a secret-shaped file it never fetched.
export interface RepoSkippedFile {
  path: string;
  reason: "vendored" | "binary" | "secret";
}

export interface RepoSnapshot {
  commit_sha: string;
  default_branch: string;
  // Files after vendored/build/binary/secret filtering.
  file_count: number;
  // GitHub cut the recursive tree listing short (a very large repository).
  tree_truncated: boolean;
  tree_summary: string;
  stack: RepoStack;
  excerpts: RepoExcerpt[];
  paths: string[];
  // What the filter left out, capped; skipped_count counts every file. Absent
  // from an API older than the trust-test fixes.
  skipped?: RepoSkippedFile[];
  skipped_count?: number;
}

export type RepoAnalysisStatus = "none" | "snapshot_ready" | "baseline_ready" | "failed";

/** GET/PATCH /projects/{id}/repo-analysis, and the SSE `snapshot`/`done`
 *  payloads of its POST (apps/cloud/app/api/repo_analysis.py). */
export interface RepoAnalysisOut {
  project_id: string;
  status: RepoAnalysisStatus;
  // True while the analysis gates planning: an imported project before
  // `repo_created`. The Planner shows its panel only then.
  required: boolean;
  commit_sha: string | null;
  snapshot: RepoSnapshot | null;
  baseline: string;
  updated_at: string | null;
  // null is "couldn't check", not "fresh".
  stale: boolean | null;
}

export interface RepoAnalysisDoneEvent extends RepoAnalysisOut {
  // Stored and usable, but the model stopped at its output limit.
  truncated: boolean;
}

/** GET /projects/{id}/repository/seed-preview (plan 0027 M4): the seed
 *  commit, computed against the repository's live tree. `write` already
 *  holds relocated files at their new path. */
export interface SeedPreview {
  write: string[];
  relocated: { from: string; to: string }[];
  skipped: string[];
  // Non-empty means create-repository refuses with deploy_workflow_conflict.
  conflicts: string[];
}

// A built-in (or, later, workspace-defined) compliance template offered by
// the Policy Scope picker (GET /policy-templates). `body` is the full
// template text, included so the picker can offer a preview with no second
// endpoint.
export interface PolicyTemplateOut {
  id: string;
  name: string;
  description: string;
  body: string;
}

// A deployment template offered by the Tech Lead's picker
// (GET /deployment-templates, apps/cloud/app/deployments/registry.py).
// `workflow_preview` and `scaffold_paths` ship inline for the same reason
// PolicyTemplateOut ships `body`: the picker previews exactly what will be
// committed, with no second round trip per template.
export interface DeploymentTemplateOut {
  id: string;
  name: string;
  description: string;
  stack: string;
  // ADR 0023: decides how the Preview tab presents this project's build.
  delivery_kind:
    | "embedded_url"
    | "external_url"
    | "api_console"
    | "artifact_download"
    | "store_build";
  provider: string;
  provider_label: string;
  provider_is_platform_owned: boolean;
  // Who owns the deploy credential. "customer" is the only one an admin can
  // connect; "platform" is minted by PromptConnext, "host" is the ephemeral
  // token the git host gives each workflow run (GitHub Pages).
  provider_credential_owner: "customer" | "platform" | "host";
  // ADR 0025. Identifiers this template needs PER PROJECT, asked for here
  // rather than in workspace settings. Empty for a platform-owned provider.
  provider_project_fields: { name: string; label: string; secret: boolean; scope: string }[];
  embeddable: boolean;
  required_secrets: string[];
  required_vars: string[];
  scaffold_paths: string[];
  workflow_preview: string;
  // The template's own caveats — what it costs and what it assumes — shown at
  // selection time, not only in the repository it later writes.
  notes: string[];
}

// A deployment provider a workspace admin connects (ADR 0023). The token is
// never returned — `connected` is the only readable proof it exists.
export interface DeployConnection {
  connected: boolean;
  provider: string;
  label: string;
  // What this provider's primary secret is called, and whether it spans more
  // than one line — an SSH private key does, an API token does not.
  token_label: string;
  token_multiline: boolean;
  fields: { name: string; label: string; secret: boolean }[];
  values: Record<string, string>;
  connected_at: string | null;
}

// One task inside a build (ADR 0023). Deliberately not a commit: the Preview
// tab speaks the platform's vocabulary, not Git's.
export interface BuildTask {
  id: string;
  title: string;
  ref: string | null;
}

export interface DeploymentOut {
  id: string;
  state: string;
  url: string | null;
  commit_sha: string | null;
  ref: string | null;
  run_url: string | null;
  frame_policy: "allow" | "deny" | "unknown" | null;
  // Frozen when the build reached a terminal state; empty while it is in flight.
  tasks: BuildTask[];
  // Whether `tasks` is an answer at all. An empty list under "frozen" means
  // this build closed nothing; an empty list under "uncomputed" means nobody
  // ever worked out what it closed — usually because the code host was
  // unreachable when it published. The two are different facts and used to
  // render identically, which is the gap plan 0024 M3 closes: an evidence
  // chain whose holes are invisible is not evidence.
  attribution_state: "uncomputed" | "frozen";
  attributed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentErrorOut {
  code: string;
  message: string;
  run_url: string | null;
  at: string;
}

// GET /projects/{id}/deployment. Shaped on IndexStatus below, and for the
// same reason: `pending` is a server-measured count you poll while it is
// above zero. There is no progress percentage here and there must not be
// one — a deploy's duration is unknown to the server, so a bar would be
// invented.
export interface DeploymentStatus {
  template_id: string | null;
  template_name: string | null;
  provider: string | null;
  embeddable: boolean;
  state: DeploymentState["state"];
  url: string | null;
  health_path: string;
  pending: number;
  last_deploy: DeploymentOut | null;
  recent: DeploymentOut[];
  last_error: DeploymentErrorOut | null;
}

// GET /projects/{id}/assistant/index-status (apps/cloud/app/api/assistant.py)
// — the completion signal POST .../reindex itself never had: that endpoint
// returns `{enqueued}` the instant jobs are queued, before anything is
// embedded. This is what actually landed, plus the two fields that make a
// frozen count readable: `pending_jobs` (this project's measured in-flight
// count, from the queue's own bookkeeping — poll while it's > 0) and
// `last_error` (a job that was discarded rather than deferred, e.g. no
// embedding model configured, which no chunk count can express).
export interface IndexJobError {
  code: string;
  message: string;
  node_type: string;
  node_id: string;
  at: string;
}

export interface IndexStatus {
  indexed_chunks: number;
  indexable_nodes: number;
  embed_model: string | null;
  pending_jobs: number;
  last_error: IndexJobError | null;
}

// POST /workspaces/{id}/assistant/reindex (apps/cloud/app/api/assistant.py)
// — the workspace-wide sibling of reindexProject: same enqueue-only
// contract ("queued", not "indexed" — no completion signal), fanned out
// across every project in the workspace. `projects` is the per-project
// breakdown the server computes while sweeping, not something the client
// derives.
export interface WorkspaceReindexResult {
  enqueued: number;
  projects_swept: number;
  projects: { project_id: string; enqueued: number }[];
}

// --- Plan 0029 delivery (apps/cloud/app/api/delivery.py) -------------------

export type ApprovalState = "none" | "pending" | "approved" | "stale" | "changes_requested";
export type DecisionKind = "intent_approval" | "plan_approval";
export type ProjectHat = "business_owner" | "tech_steward";

export interface DeliveryChange {
  id: string;
  ref: string;
  key: string;
  title: string;
  kind: "setup" | "foundational" | "story" | "other" | "polish" | "unphased";
  story: number | null;
  priority: string | null;
  position: number;
  wave: number;
  depends_on: string[];
  task_ids: string[];
  /** Live tasks of this Change that are implemented or verified. */
  done: number;
  /** Live tasks of this Change (`task_ids.length`). */
  total: number;
}

export interface DeliveryPlan {
  changes: DeliveryChange[];
  plan_approval: ApprovalState;
}

export interface Decision {
  id: string;
  project_id: string;
  workspace_id: string;
  kind: DecisionKind;
  title: string;
  subject_stage: "specify" | "tasks";
  subject_hash: string;
  /** The document text when the approval was requested. Null for a decision
   *  made before the API stored it, and for older decisions the listing leaves
   *  out: it sends the text only for open decisions and the newest approved
   *  one per kind. */
  subject_content: string | null;
  routed_hat: ProjectHat;
  status: "open" | "approved" | "rejected" | "withdrawn";
  rationale: string | null;
  requested_by: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
  can_resolve: boolean;
  /** False once the stage document was edited after this decision was made. */
  is_current: boolean;
}

export interface DecisionsOut {
  decisions: Decision[];
  states: { intent: ApprovalState; plan: ApprovalState };
}

/** A request or resolve's response: the decision, plus the project's
 *  `GET /decisions` as it stands after the write, to apply instead of refetching.
 *  `null` when the API could not read the stage documents after the write
 *  (absent from an API older than the snapshot): refetch then. */
export interface DecisionMutationOut extends Decision {
  snapshot?: DecisionsOut | null;
}

export interface ProjectRoleOut {
  hat: ProjectHat;
  user_id: string | null;
}

/** `GET /projects/{id}/delivery-overview`: what the Delivery and Decisions
 *  tabs show, in one request. `decisions` and `states` are `GET /decisions`,
 *  `plan` is `GET /delivery-plan`, `roles` is `GET /roles`. */
export interface DeliveryOverview extends DecisionsOut {
  plan: DeliveryPlan;
  roles: ProjectRoleOut[];
}

export interface InboxItem {
  /** An open decision without the document text and `is_current`, which the
   *  inbox never reads and its API leaves out. */
  decision: Omit<Decision, "subject_content" | "is_current">;
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_name: string;
}
