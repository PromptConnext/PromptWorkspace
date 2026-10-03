export const ENGINE_URL = "http://127.0.0.1:47131";

// The packaged Tauri shell injects the per-session token (ADR 0008); undefined
// in the browser/dev, where the engine runs without a token.
const AUTH_TOKEN: string | undefined = (
  globalThis as { __PROMPTWORKSPACE_TOKEN__?: string }
).__PROMPTWORKSPACE_TOKEN__;

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

// Append the token to a WS URL (browsers can't set WebSocket headers).
export function withToken(url: string): string {
  return AUTH_TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(AUTH_TOKEN)}` : url;
}

export type OnboardingState = "not_started" | "in_progress" | "satisfied";

export type Recommendation = {
  provider: string;
  label: string;
  endpoint: string;
  model: string;
  needsKey: boolean;
  role: string;
  cost?: string;
  hint?: string;
  getKeyUrl?: string;
  steps?: string[];
};

export type Connection = {
  id: string;
  role: string;
  provider: string;
  endpoint: string;
  model: string;
  healthy: boolean;
};

// Project gains its cloud-linked workspace id and cloud project id (both null
// when unlinked) — see engine GET /engine/projects annotation. cloud_project_id
// lets the desktop match a local project to its roster tab precisely by id
// rather than by name (plan 0006 G4).
export type Project = {
  id: string;
  name: string;
  path: string;
  cloud_workspace_id: string | null;
  cloud_project_id: string | null;
};

export type Graph = {
  project: Project;
  stages: { stage: string; status: string; gate_passed: number; approver: string | null }[];
  requirements: {
    id: string;
    title: string;
    description: string;
    status: string;
    specDocuments: {
      id: string;
      version: number;
      approved_by: string | null;
      content: string;
      tasks: {
        id: string;
        title: string;
        status: string;
        feature_tag?: string | null;
        assigned_user_id?: string | null;
      }[];
    }[];
  }[];
  agentRuns: {
    id: string;
    action: string;
    status: string;
    evidence: string | null;
    created_at: string;
  }[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  // Not every engine reply is JSON: a routing miss returns Hono's plain
  // "404 Not Found", and res.json() on that throws a parser error whose WebKit
  // wording ("The string did not match the expected pattern.") reaches the user
  // instead of the status that would explain it. Parse defensively.
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HTTP ${res.status} from the engine: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function engineHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/engine/health`, { headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

export const getOnboardingState = () =>
  request<{ state: OnboardingState }>("/engine/onboarding/state");

export const getRecommendations = () =>
  request<{ recommendations: Recommendation[] }>("/engine/onboarding/recommendations");

export const listModels = () => request<{ connections: Connection[] }>("/engine/models");

// Explicit disconnect (plan §7f) — clears the connection's health/credential
// state on the engine so it drops out of role resolution and the keychain.
export const deleteModelConnection = (id: string) =>
  request<{ ok: boolean }>(`/engine/models/${id}`, { method: "DELETE" });

// Local task-graph backup. The engine's SQLite file is the offline source of
// truth (ADR 0003) and cloud sync is opt-in (ADR 0010), so an offline user has
// exactly one copy of their graph until they take a snapshot.
export type BackupInfo = { path: string; bytes: number; created_at: string };

export const listBackups = () =>
  request<{ dir: string; db_path: string; backups: BackupInfo[] }>("/engine/backups");

export const createBackup = (path?: string) =>
  request<BackupInfo>("/engine/backups", {
    method: "POST",
    body: JSON.stringify(path ? { path } : {}),
  });

export const getLocalLlmEnv = () =>
  request<{ model: string; env: Record<string, string> }>("/engine/local-llm-env");

export const connectModel = (payload: {
  role: string;
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
}) =>
  request<{ id: string; verified: boolean }>("/engine/models/connect", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const listProjects = () => request<{ projects: Project[] }>("/engine/projects");

export const createProject = (name: string, path?: string) =>
  request<Project>("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name, ...(path ? { path } : {}) }),
  });

// Structured agent error kinds (engine `AgentError`, plan §7e) — lets the UI
// give kind-specific guidance (e.g. point at the AgentPicker for "no-agent",
// offer a Retry button for "network") instead of one generic error paragraph.
export type EngineErrorKind =
  | "no-agent"
  | "agent-crash"
  | "no-changes"
  | "bad-output"
  | "network"
  | "timeout";

// A plain Error with an optional `.kind` attached, so existing `catch (err)`
// call sites keep working with `(err as Error).message` while call sites that
// care can read `(err as EngineError).kind`.
export type EngineError = Error & { kind?: EngineErrorKind };

function engineError(message: string, kind?: EngineErrorKind): EngineError {
  return Object.assign(new Error(message), { kind });
}

// Stage runs stream over SSE: `delta` events carry raw model tokens, then one
// `done` (JSON payload) or `error` event ends the stream. The `error` event's
// data is JSON (`{ error, kind? }`) so the client can surface the failure kind.
async function requestSSE<T>(
  path: string,
  body: unknown,
  onDelta?: (text: string) => void,
): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw engineError((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done: T | null = null;
  let error: string | null = null;

  const handleEvent = (chunk: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    const payload = data.join("\n");
    if (event === "delta") onDelta?.(payload);
    else if (event === "done") done = JSON.parse(payload) as T;
    else if (event === "error") error = payload;
  };

  while (true) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (error) {
    // The `error` event's data is JSON (`{ error, kind? }`); fall back to
    // treating the raw payload as the message for a non-JSON error string.
    const rawError: string = error;
    let message: string = rawError;
    let kind: EngineErrorKind | undefined;
    try {
      const parsed = JSON.parse(rawError) as { error?: string; kind?: EngineErrorKind };
      message = parsed.error ?? rawError;
      kind = parsed.kind;
    } catch {
      // not JSON — use the raw payload as the message
    }
    throw engineError(message, kind);
  }
  if (done === null) throw new Error("stream ended without a result");
  return done;
}

export const runConstitution = (
  projectId: string,
  principles: string,
  onDelta?: (text: string) => void,
) =>
  requestSSE<{ files: string[]; content: string }>(
    `/engine/projects/${projectId}/constitution`,
    { principles },
    onDelta,
  );

export const runScope = (
  projectId: string,
  description: string,
  onDelta?: (text: string) => void,
  feedback?: string,
) =>
  requestSSE<{ requirementId: string; title: string; files: string[]; content: string }>(
    `/engine/projects/${projectId}/scope`,
    { description, ...(feedback ? { feedback } : {}) },
    onDelta,
  );

export const runSpec = (
  projectId: string,
  onDelta?: (text: string) => void,
  feedback?: string,
) =>
  requestSSE<{ specDocumentId: string; files: string[]; content: string }>(
    `/engine/projects/${projectId}/spec`,
    feedback ? { feedback } : {},
    onDelta,
  );

export const runTasks = (projectId: string, onDelta?: (text: string) => void) =>
  requestSSE<{ specDocumentId: string; taskCount: number; files: string[]; content: string }>(
    `/engine/projects/${projectId}/tasks`,
    {},
    onDelta,
  );

export const runTaskImplementation = (taskId: string, onDelta?: (text: string) => void) =>
  requestSSE<{ taskId: string; commitSha: string; files: string[] }>(
    `/engine/tasks/${taskId}/run`,
    {},
    onDelta,
  );

export const approveStage = (projectId: string, stage: string) =>
  request<{ ok: boolean }>(`/engine/projects/${projectId}/stages/${stage}/approve`, {
    method: "POST",
    body: JSON.stringify({ approver: "user" }),
  });

export const getGraph = (projectId: string) =>
  request<Graph>(`/engine/projects/${projectId}/graph`);

export type FileNode = { name: string; path: string; dir: boolean; children?: FileNode[] };

export const getFileTree = (projectId: string) =>
  request<{ tree: FileNode[] }>(`/engine/projects/${projectId}/files`);

export const readFile = (projectId: string, path: string) =>
  request<{ path: string; content: string }>(
    `/engine/projects/${projectId}/file?path=${encodeURIComponent(path)}`,
  );

export const writeFile = (projectId: string, path: string, content: string) =>
  request<{ path: string; saved: boolean }>(`/engine/projects/${projectId}/file`, {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });

export const getStatus = (projectId: string) =>
  request<{ changed: { state: string; path: string }[] }>(
    `/engine/projects/${projectId}/status`,
  );

export type AgentInfo = {
  id: string;
  label: string;
  installed: boolean;
  bringsOwnModel: boolean;
  installUrl?: string;
};

export const listAgents = () => request<{ agents: AgentInfo[] }>("/engine/agents");

// Cloud sync (docs/plans/0004 D1) --------------------------------------

export type CloudConfig = { enabled: boolean; mode: "stub" | "supabase"; webUrl: string };
export type CloudSession = {
  connected: boolean;
  mode: "stub" | "supabase" | null;
  userId: string | null;
  email: string | null;
};
export type CloudWorkspace = { id: string; name: string };
export type CloudLink = { linked: boolean; workspace_id?: string; project_id?: string };

export type ActiveWorkspace = { id: string; name: string };

export const getActiveWorkspace = () =>
  request<ActiveWorkspace | null>("/engine/cloud/active-workspace");

export const setActiveWorkspace = (id: string) =>
  request<ActiveWorkspace>("/engine/cloud/active-workspace", {
    method: "PUT",
    body: JSON.stringify({ id }),
  });

export const clearActiveWorkspace = () =>
  request<{ ok: boolean }>("/engine/cloud/active-workspace", { method: "DELETE" });

export const getCloudConfig = () => request<CloudConfig>("/engine/cloud/config");

export const getCloudSession = () => request<CloudSession>("/engine/cloud/session");

export const cloudLogin = (payload: { userId: string }) =>
  request<CloudSession>("/engine/cloud/login", { method: "POST", body: JSON.stringify(payload) });

export const startBrowserLogin = () =>
  request<{ url: string; state: string }>("/engine/cloud/login/browser", { method: "POST" });

export const redeemBrowserLogin = (code: string, state: string) =>
  request<CloudSession>("/engine/cloud/login/redeem", {
    method: "POST",
    body: JSON.stringify({ code, state }),
  });

export const cloudLogout = () =>
  request<{ ok: boolean }>("/engine/cloud/logout", { method: "POST" });

export const listCloudWorkspaces = () =>
  request<{ workspaces: CloudWorkspace[] }>("/engine/cloud/workspaces");

export const createCloudWorkspace = (name: string) =>
  request<CloudWorkspace>("/engine/cloud/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const getCloudLink = (projectId: string) =>
  request<CloudLink>(`/engine/projects/${projectId}/cloud-link`);

export const linkProjectToCloud = (projectId: string, workspaceId: string) =>
  request<CloudLink>(`/engine/projects/${projectId}/cloud-link`, {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });

export const unlinkProjectFromCloud = (projectId: string) =>
  request<CloudLink>(`/engine/projects/${projectId}/cloud-link`, { method: "DELETE" });

export type CloudSyncResult = {
  at: string | null;
  ok: boolean | null;
  upserted?: Record<string, number>;
  // Entity id -> field names the cloud's ownership/LWW merge gate silently
  // dropped on this push (WP2 — sync conflict visibility). Non-empty means a
  // teammate's edit was overwritten and the UI should warn about it.
  conflicts?: Record<string, string[]>;
  error?: string;
};

export const triggerCloudSync = (projectId: string) =>
  request<CloudSyncResult>(`/engine/projects/${projectId}/cloud-sync`, { method: "POST" });

export const getCloudSyncStatus = (projectId: string) =>
  request<CloudSyncResult>(`/engine/projects/${projectId}/cloud-sync`);

export const getProjectAgent = (projectId: string) =>
  request<{ selected: string }>(`/engine/projects/${projectId}/agent`);

export const setProjectAgent = (projectId: string, agentId: string) =>
  request<{ selected: string }>(`/engine/projects/${projectId}/agent`, {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });

// Discussions (M12) -----------------------------------------------------

export type Discussion = {
  id: string;
  project_id: string;
  parent_node_type: string;
  parent_node_id: string;
  author: string;
  body: string;
  source: "pz" | "pmo";
  updated_at: string;
};

export const listDiscussions = (projectId: string, parentNodeType?: string, parentNodeId?: string) => {
  const query =
    parentNodeType && parentNodeId
      ? `?parentNodeType=${encodeURIComponent(parentNodeType)}&parentNodeId=${encodeURIComponent(parentNodeId)}`
      : "";
  return request<{ discussions: Discussion[] }>(`/engine/projects/${projectId}/discussions${query}`);
};

export const createDiscussion = (
  projectId: string,
  parentNodeType: string,
  parentNodeId: string,
  body: string,
) =>
  request<Discussion>(`/engine/projects/${projectId}/discussions`, {
    method: "POST",
    body: JSON.stringify({ parentNodeType, parentNodeId, body }),
  });

// Cloud-projected roster (ADR 0015 §2, plan 0006 G2/G3) ----------------
// The cloud is authoritative for *which* workspaces/projects a signed-in user
// has; the engine mirrors it into a local cache so the desktop renders offline.
// These wrap G2's already-shipped engine routes — no new endpoints.

export type RosterWorkspace = { id: string; name: string };
// Cloud Planner lifecycle (plan: cloud creates the repo at tech-review exit):
// planning -> pending_tech_review -> tech_review -> repo_created. Matches what
// the engine's roster cache carries (apps/engine/src/cloudClient.ts:77-89) so
// the desktop can gate opening a project on repo_created and decide clone vs.
// init from repo_url's presence, instead of always git-initing an empty folder.
export type RosterProject = {
  id: string;
  name: string;
  workspace_id: string;
  lifecycle_status: string;
  repo_url: string | null;
  repo_default_branch: string | null;
};

export type CloudRoster = {
  workspaces: RosterWorkspace[];
  projects: RosterProject[];
  syncedAt: string | null;
};

// Refresh distinguishes a live pull from a cached fallback: `offline: true`
// means the cloud was unreachable and the cache was served — NOT that the user
// has no workspaces (ADR 0015 state 4).
export type CloudRosterRefresh = CloudRoster & { offline: boolean; error?: string };

// Read the cached roster — no network, renders offline from the last sync.
export const getCloudRoster = () => request<CloudRoster>("/engine/cloud/roster");

// Pull the roster live (on sign-in / focus / explicit refresh); falls back to
// the cache with offline:true when the cloud is unreachable.
export const refreshCloudRoster = () =>
  request<CloudRosterRefresh>("/engine/cloud/roster/refresh", { method: "POST" });

// Cached workspace members (ADR 0018 M4) — resolves a task's assigned_user_id
// to a display name. No network; reads the cache the roster refresh fed.
export type WorkspaceMember = { workspace_id: string; user_id: string; email: string | null; role: string };

export const getWorkspaceMembers = (workspaceId: string) =>
  request<{ members: WorkspaceMember[] }>(`/engine/workspaces/${workspaceId}/members`);

export type OpenCloudProjectResult = {
  localProjectId: string;
  hydrated: boolean;
};

// Resolve a roster (cloud) project to a usable local project: returns the
// existing local id if this machine already has it, otherwise materializes a
// local shell and full-graph bootstrap-pulls the cloud's merged state into it.
export const openCloudProject = (cloudProjectId: string, path?: string) =>
  request<OpenCloudProjectResult>(
    `/engine/cloud/projects/${encodeURIComponent(cloudProjectId)}/open`,
    { method: "POST", body: JSON.stringify(path ? { path } : {}) },
  );
