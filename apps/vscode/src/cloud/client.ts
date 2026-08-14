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
import type { AssignedTask, ProjectGraph, StageDocument, Task, TaskStatus, TaskStatusUpdate } from "./types.ts";

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
}

export interface AssignedTaskQuery {
  workspaceId?: string;
  statuses?: TaskStatus[];
  limit?: number;
}

export class CloudClient {
  private readonly deps: CloudClientDeps;
  // Supabase ROTATES the refresh token on every use, so two concurrent
  // refreshes mean all but one fail with `invalid_grant` — and the loser would
  // sign a perfectly valid session out. Everything funnels through this one
  // in-flight promise. (Carried over verbatim in intent from the engine; it is
  // the least obvious and most load-bearing thing in the original file.)
  private inFlightRefresh: Promise<string | null> | null = null;

  constructor(deps: CloudClientDeps) {
    this.deps = deps;
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

    let res = await this.request(apiUrl, path, init, await this.authHeaders(session));
    if (res.status === 401 && session.mode === "supabase") {
      const token = await this.refreshSession();
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

  private refreshSession(): Promise<string | null> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefresh().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefresh(): Promise<string | null> {
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
        // Definitively rejected: the session is gone, so say so. Any other
        // failure is treated as "offline" and must NOT sign the user out.
        this.deps.log.warn(`refresh rejected, signing out: ${err.message}`);
        await this.deps.session.clear();
      } else {
        this.deps.log.info(`refresh failed (offline?): ${String(err)}`);
      }
      return null;
    }
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
      // 4xx from the auth server means this refresh token will never work
      // again; 5xx or a network throw might.
      if (res.status >= 400 && res.status < 500) {
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
