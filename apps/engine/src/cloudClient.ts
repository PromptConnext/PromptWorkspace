// Thin fetch wrapper around apps/cloud's REST API (docs/plans/0004 D1-D2).
// Mirrors apps/desktop/src/api.ts's request<T> shape on the other side of the
// engine, but authenticates as the *cloud* user, not the local engine session.
import { db, getAppState, setAppState } from "./db.ts";
import { readSecret, storeSecret, deleteSecret } from "./keychain.ts";
import { CLOUD_API_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.ts";

const SESSION_KEY = "cloud_session";
const SESSION_CRED = "cloud.session";
const REFRESH_CRED = "cloud.refresh";
const ACTIVE_WS_KEY = "active_workspace";
// Roster cache (ADR 0015, plan 0006 G2): the cloud-authoritative mirror of the
// workspaces/projects this identity can see. Metadata only — never a model key,
// never code (ADR 0010 §5). Persisted so the desktop renders fully offline from
// the last sync, with no live network check required to read it.
const ROSTER_WORKSPACES_KEY = "roster_workspaces";
const ROSTER_PROJECTS_KEY = "roster_projects";
const ROSTER_SYNCED_AT_KEY = "roster_synced_at";

export type CloudSession = { mode: "stub" | "supabase"; userId: string; email?: string };

// Pulls the `email` claim off a Supabase access token's payload, without
// verifying the signature — the token was already validated by the cloud's
// redeem exchange (or is about to be sent to the cloud, which will reject it
// if forged), so this is display-only, not an auth decision.
export function emailFromAccessToken(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { email?: string };
    return claims.email;
  } catch {
    return undefined;
  }
}

export function cloudMode(): "stub" | "supabase" {
  return SUPABASE_URL && SUPABASE_ANON_KEY ? "supabase" : "stub";
}

export function loadCloudSession(): CloudSession | null {
  const raw = getAppState(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudSession;
  } catch {
    return null;
  }
}

export function storeCloudSession(
  session: CloudSession,
  token?: string,
  refreshToken?: string,
): void {
  if (token) storeSecret(SESSION_CRED, token);
  if (refreshToken) storeSecret(REFRESH_CRED, refreshToken);
  setAppState(SESSION_KEY, JSON.stringify(session));
}

export function clearCloudSession(): void {
  deleteSecret(SESSION_CRED);
  deleteSecret(REFRESH_CRED);
  setAppState(SESSION_KEY, JSON.stringify(null));
  setAppState(ACTIVE_WS_KEY, JSON.stringify(null)); // active workspace is tied to the session
  // Sign-out teardown (ADR 0015 §3.4): scrub the roster so workspace/project
  // names can't leak to the next user of a shared machine. Local project
  // *graphs* on disk are retained (unreachable until re-auth), not wiped here.
  clearRoster();
}

// --- Roster cache (ADR 0015 §2, plan 0006 G2) ------------------------------
// The desktop reads this to render workspaces/projects fully offline. It is a
// mirror of the cloud-authoritative GET /workspaces + GET /projects — the
// engine never treats it as a source of truth, only a last-known snapshot.

export type RosterWorkspace = { id: string; name: string };
export type RosterProject = {
  id: string;
  name: string;
  workspace_id: string;
  // Cloud Planner lifecycle (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md):
  // planning -> pending_tech_review -> tech_review -> repo_created. Desktop
  // reads these to decide whether a roster project with no local counterpart
  // yet is "clone this repo" (repo_url set) vs. still being planned.
  lifecycle_status: string;
  repo_url: string | null;
  repo_default_branch: string | null;
};

export function storeRoster(workspaces: RosterWorkspace[], projects: RosterProject[]): void {
  setAppState(ROSTER_WORKSPACES_KEY, JSON.stringify(workspaces));
  setAppState(ROSTER_PROJECTS_KEY, JSON.stringify(projects));
  setAppState(ROSTER_SYNCED_AT_KEY, JSON.stringify(new Date().toISOString()));
}

function loadJson<T>(key: string, fallback: T): T {
  const raw = getAppState(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as T | null;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function loadRosterWorkspaces(): RosterWorkspace[] {
  return loadJson<RosterWorkspace[]>(ROSTER_WORKSPACES_KEY, []);
}

export function loadRosterProjects(): RosterProject[] {
  return loadJson<RosterProject[]>(ROSTER_PROJECTS_KEY, []);
}

export function rosterSyncedAt(): string | null {
  return loadJson<string | null>(ROSTER_SYNCED_AT_KEY, null);
}

export function clearRoster(): void {
  setAppState(ROSTER_WORKSPACES_KEY, JSON.stringify(null));
  setAppState(ROSTER_PROJECTS_KEY, JSON.stringify(null));
  setAppState(ROSTER_SYNCED_AT_KEY, JSON.stringify(null));
  clearWorkspaceMembersCache();
}

// --- Workspace-members cache (ADR 0016 M4) ---------------------------------
// Resolves a task's assigned_user_id to a display name on the desktop.
// Refreshed alongside the roster; scrubbed on sign-out for the same privacy
// reason the roster itself is (ADR 0015 §3.4).

export type CachedMember = { workspace_id: string; user_id: string; email: string | null; role: string };

const upsertMember = db.prepare(`
  INSERT INTO workspace_members_cache (workspace_id, user_id, email, role)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(workspace_id, user_id) DO UPDATE SET email = excluded.email, role = excluded.role
`);

export function storeWorkspaceMembers(workspaceId: string, members: CachedMember[]): void {
  db.prepare("DELETE FROM workspace_members_cache WHERE workspace_id = ?").run(workspaceId);
  for (const m of members) {
    upsertMember.run(workspaceId, m.user_id, m.email, m.role);
  }
}

export function loadWorkspaceMembers(workspaceId: string): CachedMember[] {
  return db
    .prepare(
      "SELECT workspace_id, user_id, email, role FROM workspace_members_cache WHERE workspace_id = ?",
    )
    .all(workspaceId) as CachedMember[];
}

export function clearWorkspaceMembersCache(): void {
  db.prepare("DELETE FROM workspace_members_cache").run();
}

export type ActiveWorkspace = { id: string; name: string };

export function loadActiveWorkspace(): ActiveWorkspace | null {
  const raw = getAppState(ACTIVE_WS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveWorkspace;
  } catch {
    return null;
  }
}

export function storeActiveWorkspace(ws: ActiveWorkspace): void {
  setAppState(ACTIVE_WS_KEY, JSON.stringify(ws));
}

export function clearActiveWorkspace(): void {
  setAppState(ACTIVE_WS_KEY, JSON.stringify(null));
}

function authHeaders(session: CloudSession): Record<string, string> {
  if (session.mode === "supabase") {
    const token = readSecret(SESSION_CRED);
    if (!token) throw new Error("cloud session token missing — log in again");
    return { authorization: `Bearer ${token}` };
  }
  return { "x-user-id": session.userId };
}

export class CloudNotConfiguredError extends Error {
  constructor() {
    super("cloud sync is not configured (CLOUD_API_URL unset)");
  }
}

export class CloudNotLoggedInError extends Error {
  constructor() {
    super("not logged in to PromptConnext Cloud");
  }
}

function requestCloud(path: string, init: RequestInit, session: CloudSession): Promise<Response> {
  return fetch(`${CLOUD_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(session),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

// Coalesce concurrent refreshes. The sync loop (every ~20s) and on-demand pushes
// both call cloudFetch, so several requests can hit a 401 at the same expiry
// moment. Supabase rotates the refresh token on each use, so letting each caller
// refresh independently would make all but the first fail with invalid_grant.
// Sharing one in-flight refresh means a single rotation, and every caller retries
// with the token it produced.
let inFlightRefresh: Promise<void> | null = null;

function refreshCloudSession(session: CloudSession): Promise<void> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      const current = readSecret(REFRESH_CRED);
      if (!current) throw new Error("no refresh token stored");
      const refreshed = await supabaseRefresh(current);
      storeCloudSession(session, refreshed.token, refreshed.refreshToken);
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

// Authenticated call against apps/cloud, using whichever session is stored.
export async function cloudFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!CLOUD_API_URL) throw new CloudNotConfiguredError();
  const session = loadCloudSession();
  if (!session) throw new CloudNotLoggedInError();

  let res = await requestCloud(path, init, session);

  // Supabase access tokens expire (~1h). On a 401, refresh once with the stored
  // rotating refresh token and retry, so long-lived sync survives without a new
  // browser login (ADR 0014). authHeaders() re-reads the token from the keychain,
  // so the retry picks up the freshly stored access token. If refresh fails
  // (token expired or already rotated away), the original 401 propagates and the
  // user must re-authenticate through the browser flow.
  if (res.status === 401 && session.mode === "supabase" && readSecret(REFRESH_CRED)) {
    try {
      await refreshCloudSession(session);
      res = await requestCloud(path, init, session);
    } catch (err) {
      // A definitive rejection (not a network-level failure) means the
      // session is unrenewable — clear it so the next session check reports
      // signed-out (ADR 0015 state 5) instead of staying "connected" forever
      // on stale keychain data. Keep the original 401 response either way;
      // fall through to the error below.
      if (err instanceof CloudRefreshInvalidError) clearCloudSession();
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `cloud HTTP ${res.status}`);
  }
  return data as T;
}

// Real Supabase password-grant login — only used when SUPABASE_URL/ANON_KEY
// are configured. Returns the access token + resolved user id; caller is
// responsible for persisting the session.
export async function supabasePasswordLogin(
  email: string,
  password: string,
): Promise<{ token: string; userId: string }> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase auth is not configured");
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error_description?: string; msg?: string };
    throw new Error(err.error_description ?? err.msg ?? "login failed");
  }
  const ok = data as { access_token: string; user: { id: string } };
  return { token: ok.access_token, userId: ok.user.id };
}

// Thrown when Supabase returns a definitive HTTP rejection of the refresh
// token (e.g. invalid_grant — expired, revoked, or already rotated away).
// Distinct from a network-level failure (fetch() itself throwing, e.g.
// offline): only a definitive rejection means the session is unrenewable
// (ADR 0015 state 5), not merely unreachable (state 4).
export class CloudRefreshInvalidError extends Error {}

// Exchange a rotating refresh token for a fresh access token (Supabase rotates
// the refresh token on every use, so the new one must be persisted too). Used by
// cloudFetch's refresh-on-401 retry.
export async function supabaseRefresh(
  refreshToken: string,
): Promise<{ token: string; refreshToken: string }> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase auth is not configured");
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error?: string; error_description?: string; msg?: string };
    const message = err.error_description ?? err.msg ?? "token refresh failed";
    // A response was received (we're not offline) and Supabase rejected the
    // token outright — this is unrenewable, not transient.
    throw new CloudRefreshInvalidError(message);
  }
  const ok = data as { access_token: string; refresh_token: string };
  return { token: ok.access_token, refreshToken: ok.refresh_token };
}

// Exchange a one-time handoff code (from the promptconnext:// callback) for the
// Supabase session, via apps/cloud's unauthenticated redeem endpoint (ADR 0014).
export async function redeemDesktopCode(
  code: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  if (!CLOUD_API_URL) throw new CloudNotConfiguredError();
  const res = await fetch(`${CLOUD_API_URL}/desktop-auth/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { detail?: string }).detail ?? `redeem failed (HTTP ${res.status})`);
  }
  const ok = data as { access_token: string; refresh_token: string; user_id: string };
  return { accessToken: ok.access_token, refreshToken: ok.refresh_token, userId: ok.user_id };
}
