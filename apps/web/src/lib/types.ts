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

export interface GenerateDoneEvent {
  stage: StageKind;
  title: string;
  content: string;
  requirement_id?: string;
  spec_document_id?: string;
  task_count?: number;
  // The model stopped at its output limit — the document is real but cut off.
  truncated?: boolean;
  // Whether the raw markdown was written to the stage-document side store,
  // i.e. whether it will still be there on the next visit to the project.
  saved?: boolean;
  updated_at?: string;
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
  provider: string;
  provider_label: string;
  provider_is_platform_owned: boolean;
  embeddable: boolean;
  required_secrets: string[];
  required_vars: string[];
  scaffold_paths: string[];
  workflow_preview: string;
}

export interface DeploymentOut {
  id: string;
  state: string;
  url: string | null;
  commit_sha: string | null;
  ref: string | null;
  run_url: string | null;
  frame_policy: "allow" | "deny" | "unknown" | null;
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
