// Cloud API client. Port of apps/engine/src/cloudClient.ts (~359 lines), minus
// the roster cache and password login, plus the typed reads and the one write
// this extension is allowed to make.
//
// The engine reached the cloud from a Node process it owned. Here the same code
// runs in the extension host, which changes exactly one thing structurally:
// SecretStorage is async, so token reads are awaited. Everything else — above
// all the refresh coalescing — is carried across intact.

import { CloudHttpError, CloudNotConfiguredError, CloudNotLoggedInError, CloudRefreshInvalidError } from "./errors.ts";
import type { CloudSession, SessionStore } from "./session.ts";
import { emailFromAccessToken } from "./session.ts";
import type { AssignedTask, CloudProject, ProjectGraph, StageDocument, Task, TaskStatus, TaskStatusUpdate, Workspace } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CloudConfig {
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface CloudClientDeps {
  session: SessionStore;
  config: () => CloudConfig;
  fetch: FetchLike;
  log: LoggerLike;
  /** Epoch ms; the refresh lease's clock. Injected for tests. */
  now?: () => number;
  /** Every wait in the refresh path. Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AssignedTaskQuery {
  workspaceId?: string;
  statuses?: TaskStatus[];
  limit?: number;
}

/** How long to look for another window's rotated session after a rejected
 *  refresh: three looks, 200 ms apart. */
const ROTATION_LOOKS = 3;
const ROTATION_LOOK_MS = 200;

/** How long a refresh lease lasts. Long enough for one refresh call; short
 *  enough that a window which crashed holding it delays the others once. */
const LEASE_MS = 10_000;
/** Write, wait this long, read back: the last writer in that window holds the
 *  lease. Shared storage has no compare-and-set, so this is the arbitration.
 *  apps/vscode's lease file is visible to every window on rename; the margin
 *  is for stores that propagate slower (the tests model a delayed, whole-blob
 *  one). Costs this much once per refresh, i.e. once an hour. Getting it wrong
 *  in either direction (both win, both lose) is survivable — see doRefresh. */
const LEASE_SETTLE_MS = 300;
/** How often a window waiting on another's refresh re-reads the secrets. */
const LEASE_POLL_MS = 200;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CloudClient {
  private readonly deps: CloudClientDeps;
  // Supabase ROTATES the refresh token on every use, so two concurrent
  // refreshes mean all but one fail with `invalid_grant` — and the loser would
  // sign a perfectly valid session out. Everything funnels through this one
  // in-flight promise. (Carried over verbatim in intent from the engine; it is
  // the least obvious and most load-bearing thing in the original file.)
  // It only coalesces inside one process. Every editor window runs its own
  // client over the same SecretStorage, so a rejection must also be checked
  // against what another window has since stored: see `awaitRotatedSession`.
  private inFlightRefresh: Promise<string | null> | null = null;
  // And across windows, a lease in a store every window reads (finding
  // #50a): N windows used to make N refresh calls per expiry, all but one
  // losing the rotation. One holds the lease and refreshes; the others re-read
  // the secrets for the pair it stores. Best-effort by construction — when it
  // fails, two windows refresh, which `awaitRotatedSession` already survives.
  private readonly leaseOwner = globalThis.crypto.randomUUID();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: CloudClientDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
  }

  /** Whether a session is stored right now. A request can fail 401 and clear
   *  it on the way; callers use this to tell "the session is gone" from "the
   *  server said no". */
  signedIn(): boolean {
    return this.deps.session.read() !== null;
  }

  /** Whether a refresh token is stored. With `signedIn()` this tells a 401
   *  from a session that is really gone (no way back but signing in) from one
   *  the refresh path only gave up on for now (auth server down, another
   *  window's rotation not visible yet), which callers must treat as offline. */
  async hasRefreshToken(): Promise<boolean> {
    return Boolean(await this.deps.session.refreshToken());
  }

  mode(): "stub" | "supabase" {
    const { supabaseUrl, supabaseAnonKey } = this.deps.config();
    return supabaseUrl && supabaseAnonKey ? "supabase" : "stub";
  }

  // ---------------------------------------------------------------- transport

  async cloudFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { apiUrl } = this.deps.config();
    if (!apiUrl) throw new CloudNotConfiguredError();
    const session = this.deps.session.read();
    if (!session) throw new CloudNotLoggedInError();

    const headers = await this.authHeaders(session);
    let res = await this.request(apiUrl, path, init, headers);
    if (res.status === 401 && session.mode === "supabase") {
      const token = await this.refreshSession(headers.authorization?.replace(/^Bearer /, ""));
      if (token) {
        res = await this.request(apiUrl, path, init, {
          authorization: `Bearer ${token}`,
        });
      }
    }
    if (!res.ok) throw await this.httpError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async request(
    apiUrl: string,
    path: string,
    init: RequestInit,
    auth: Record<string, string>,
  ): Promise<Response> {
    return this.deps.fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...auth,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  private async authHeaders(session: CloudSession): Promise<Record<string, string>> {
    if (session.mode === "stub") return { "x-user-id": session.userId };
    const token = await this.deps.session.accessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private async httpError(res: Response): Promise<CloudHttpError> {
    let message = `cloud HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown; error?: unknown };
      const detail = body.detail ?? body.error;
      if (typeof detail === "string") message = detail;
    } catch {
      // Not JSON — the status line is all we have, which is enough.
    }
    return new CloudHttpError(res.status, message);
  }

  // ------------------------------------------------------------------- auth

  private refreshSession(rejectedAccess?: string): Promise<string | null> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefresh(rejectedAccess).finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefresh(rejectedAccess?: string): Promise<string | null> {
    // Another window may have refreshed since this request was built: if the
    // stored access token is not the one that just got a 401, use it and leave
    // the refresh token alone. This removes most of the cross-window race.
    const stored = await this.deps.session.accessToken();
    if (rejectedAccess && stored && stored !== rejectedAccess) return stored;

    if (!(await this.deps.session.refreshToken())) return null;
    if (!this.deps.session.read()) return null;

    // One window refreshes at a time. If another holds the lease, wait for
    // the pair it stores (`adopt`). Otherwise refresh: holding the lease, or —
    // when it could not be won in time — without it, because a lease is only
    // a way to cut duplicate refreshes and must never turn into a 401 of its
    // own; `awaitRotatedSession` settles a collision. `failed` is the token
    // this window last had: anything else stored later is newer.
    const failed = rejectedAccess ?? stored;
    const turn = await this.awaitRefreshTurn(failed);
    if (turn.kind === "adopt") return turn.accessToken;
    if (turn.kind === "signed_out") return null;
    try {
      return await this.refreshHoldingLease(failed);
    } finally {
      if ((await this.deps.session.readRefreshLease())?.owner === this.leaseOwner) {
        await this.deps.session.writeRefreshLease(undefined);
      }
    }
  }

  /**
   * Take the refresh lease, or wait for whoever holds it.
   *
   * While another window holds a live lease this re-reads the secrets every
   * LEASE_POLL_MS: a stored access token that is not the one that just failed
   * is that window's result, adopted without a refresh call of our own. A
   * lease that is released, or that outlives its `until` (its holder crashed),
   * is taken. The whole wait is bounded: past it the caller refreshes without
   * the lease (`no_lease`) rather than failing the request.
   */
  private async awaitRefreshTurn(
    failedAccess: string | undefined,
  ): Promise<
    | { kind: "lease" }
    | { kind: "no_lease" }
    | { kind: "adopt"; accessToken: string }
    | { kind: "signed_out" }
  > {
    const deadline = this.now() + 2 * LEASE_MS;
    for (;;) {
      const lease = await this.deps.session.readRefreshLease();
      const free = !lease || lease.owner === this.leaseOwner || lease.until <= this.now();
      if (free && (await this.takeRefreshLease())) return { kind: "lease" };

      const access = await this.deps.session.accessToken();
      if (access && access !== failedAccess) {
        this.deps.log.info("another window refreshed the session; using its token");
        return { kind: "adopt", accessToken: access };
      }
      // Signed out (by another window, or by us) while waiting.
      if (!(await this.deps.session.refreshToken()) || !this.deps.session.read()) {
        return { kind: "signed_out" };
      }
      if (this.now() >= deadline) {
        this.deps.log.info("could not win the refresh lease in time; refreshing without it");
        return { kind: "no_lease" };
      }
      await this.sleep(LEASE_POLL_MS);
    }
  }

  private async takeRefreshLease(): Promise<boolean> {
    await this.deps.session.writeRefreshLease({
      owner: this.leaseOwner,
      until: this.now() + LEASE_MS,
    });
    await this.sleep(LEASE_SETTLE_MS);
    const won = (await this.deps.session.readRefreshLease())?.owner === this.leaseOwner;
    if (!won) this.deps.log.info("lost the refresh lease to another window; waiting for its refresh");
    return won;
  }

  private async refreshHoldingLease(failedAccess: string | undefined): Promise<string | null> {
    // Re-read under the lease: the previous holder may have just stored a
    // fresh pair, and spending its refresh token again would lose the
    // rotation we waited to avoid.
    const stored = await this.deps.session.accessToken();
    if (stored && stored !== failedAccess) return stored;
    const refreshToken = await this.deps.session.refreshToken();
    if (!refreshToken) return null;
    const session = this.deps.session.read();
    if (!session) return null;
    try {
      const next = await this.supabaseRefresh(refreshToken);
      await this.deps.session.store(session, next.token, next.refreshToken);
      return next.token;
    } catch (err) {
      if (err instanceof CloudRefreshInvalidError) {
        // Rejected, but not necessarily gone: another window may have won the
        // rotation and stored the new pair. Only a rejection of the token that
        // is still the stored one is definitive.
        const rotation = await this.awaitRotatedSession(refreshToken, failedAccess);
        if (rotation.rotated) {
          this.deps.log.info("refresh lost the rotation to another window; using its session");
          return rotation.accessToken;
        }
        // Definitively rejected: the session is gone, so say so. Any other
        // failure is treated as "offline" and must NOT sign the user out.
        this.deps.log.warn(`refresh rejected, signing out: ${err.message}`);
        // Compare-and-clear: sign out only if the stored token is still the
        // rejected one, read immediately before deleting.
        await this.deps.session.clearIfRefreshToken(refreshToken);
      } else {
        this.deps.log.info(`refresh failed (offline?): ${String(err)}`);
      }
      return null;
    }
  }

  /**
   * Every editor window runs this extension over one shared SecretStorage, and
   * a new session lands in all of them at once, so they all refresh with the
   * same refresh token in the same moment. Supabase rotates it: one window
   * wins and stores the new pair, the others are told `refresh_token_not_found`
   * and, treating that as definitive, used to delete the shared session — the
   * winner's included. (Seen on 2026-10-04, 10-06 and 10-07: two windows
   * rejecting 6 ms apart, minutes after each sign-in.)
   *
   * So a rejection is checked against the store first. If the stored refresh
   * token is no longer the one that was rejected, someone else rotated it. The
   * writer stores the access token before the refresh token, but storage is
   * shared across processes and only eventually consistent, so the new access
   * token is looked for for a moment rather than trusted to be there.
   * `rotated: false` means the token never changed: the rejection is real.
   */
  private async awaitRotatedSession(
    rejected: string,
    staleAccess?: string,
  ): Promise<{ rotated: true; accessToken: string | null } | { rotated: false }> {
    let rotated = false;
    for (let look = 0; look < ROTATION_LOOKS; look++) {
      const current = await this.deps.session.refreshToken();
      if (current && current !== rejected) {
        rotated = true;
        const access = await this.deps.session.accessToken();
        if (access && access !== staleAccess) return { rotated: true, accessToken: access };
      }
      if (look < ROTATION_LOOKS - 1) await this.sleep(ROTATION_LOOK_MS);
    }
    // Rotated by someone else but no usable access token yet: not a sign-out,
    // and not a token either. The caller's retry is skipped; the next call
    // starts from the stored (rotated) pair.
    return rotated ? { rotated: true, accessToken: null } : { rotated: false };
  }

  async supabaseRefresh(
    refreshToken: string,
  ): Promise<{ token: string; refreshToken: string }> {
    const { supabaseUrl, supabaseAnonKey } = this.deps.config();
    if (!supabaseUrl || !supabaseAnonKey) throw new CloudNotConfiguredError();
    const res = await this.deps.fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", apikey: supabaseAnonKey },
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 400/401/403 from the auth server mean this refresh token will never
      // work again; 408/429 (N windows refreshing at once is exactly when
      // Supabase rate-limits), 5xx or a network throw might.
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new CloudRefreshInvalidError(text || `supabase HTTP ${res.status}`);
      }
      throw new Error(text || `supabase HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    return { token: body.access_token, refreshToken: body.refresh_token };
  }

  /** Redeem the one-time code the web sign-in page hands back. Unauthenticated
   *  by design — the short-TTL single-use code IS the credential. */
  async redeemDesktopCode(code: string): Promise<CloudSession> {
    const { apiUrl } = this.deps.config();
    if (!apiUrl) throw new CloudNotConfiguredError();
    const res = await this.deps.fetch(`${apiUrl}/desktop-auth/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw await this.httpError(res);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      user_id: string;
    };
    const session: CloudSession = {
      mode: "supabase",
      userId: body.user_id,
      email: emailFromAccessToken(body.access_token),
    };
    await this.deps.session.store(session, body.access_token, body.refresh_token);
    return session;
  }

  /** Local-development sign-in against the cloud's stub auth mode, where
   *  identity is just an `X-User-Id` header. Never reaches a real deployment:
   *  a cloud in supabase mode rejects the header outright. */
  async signInStub(userId: string): Promise<CloudSession> {
    const session: CloudSession = { mode: "stub", userId };
    await this.deps.session.store(session);
    return session;
  }

  // ------------------------------------------------------------------ reads

  listAssignedTasks(query: AssignedTaskQuery = {}): Promise<AssignedTask[]> {
    const params = new URLSearchParams();
    if (query.workspaceId) params.set("workspace_id", query.workspaceId);
    for (const status of query.statuses ?? []) params.append("status", status);
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.cloudFetch<AssignedTask[]>(`/me/tasks${qs ? `?${qs}` : ""}`);
  }

  /** Every workspace the caller is a member of. The cloud auto-provisions a
   *  personal workspace on a first resolve with zero memberships (ADR 0015),
   *  so an empty array here means a real failure, not a new account. */
  listWorkspaces(): Promise<Workspace[]> {
    return this.cloudFetch<Workspace[]>("/workspaces");
  }

  /** Membership-gated on the cloud side by `require_workspace`, so a 403 here
   *  is a revoked membership and must drop that one workspace, never the tree. */
  listWorkspaceProjects(workspaceId: string): Promise<CloudProject[]> {
    return this.cloudFetch<CloudProject[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    );
  }

  getProjectGraph(projectId: string, since?: string): Promise<ProjectGraph> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.cloudFetch<ProjectGraph>(`/sync/projects/${projectId}/graph${qs}`);
  }

  getStageDocument(projectId: string, stage: string): Promise<StageDocument> {
    return this.cloudFetch<StageDocument>(
      `/projects/${projectId}/stage-documents/${stage}`,
    );
  }

  // ------------------------------------------------------------------ writes
  //
  // ADR 0020 decision 2: a task client writes exactly three things upward, each
  // through a purpose-built endpoint. There is no full-graph push here and
  // there must never be one — `PUT /sync/projects/{id}/graph` would let this
  // extension overwrite the requirements and specs the cloud authored.

  patchTaskStatus(
    projectId: string,
    taskId: string,
    body: TaskStatusUpdate,
  ): Promise<Task> {
    return this.cloudFetch<Task>(`/projects/${projectId}/tasks/${taskId}/status`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  assignTask(
    projectId: string,
    taskId: string,
    assignedUserId: string | null,
  ): Promise<Task> {
    return this.cloudFetch<Task>(
      `/projects/${projectId}/tasks/${taskId}/assignment`,
      { method: "PATCH", body: JSON.stringify({ assigned_user_id: assignedUserId }) },
    );
  }

  postDiscussion(
    projectId: string,
    parentNodeType: string,
    parentNodeId: string,
    body: string,
  ): Promise<unknown> {
    return this.cloudFetch(`/projects/${projectId}/discussions`, {
      method: "POST",
      body: JSON.stringify({
        parent_node_type: parentNodeType,
        parent_node_id: parentNodeId,
        body,
      }),
    });
  }
}
