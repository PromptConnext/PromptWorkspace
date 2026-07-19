import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { CLOUD_API_URL, CLOUD_WEB_URL } from "../config.ts";
import {
  cloudFetch,
  cloudMode,
  clearCloudSession,
  clearActiveWorkspace,
  emailFromAccessToken,
  loadCloudSession,
  loadActiveWorkspace,
  loadRosterProjects,
  loadRosterWorkspaces,
  redeemDesktopCode,
  rosterSyncedAt,
  storeCloudSession,
  storeActiveWorkspace,
  storeRoster,
  type ActiveWorkspace,
  type RosterProject,
  type RosterWorkspace,
} from "../cloudClient.ts";
import {
  getCloudLink,
  hydrateProjectGraph,
  lastSyncResult,
  pushProjectSnapshot,
  writeCloudLink,
} from "../sync/loop.ts";
import { createLocalProjectShell } from "./projects.ts";

export const cloud = new Hono();

// D1 (docs/plans/0004): auth + workspace linking. The engine talks to
// apps/cloud as a real cloud identity, separate from the local Tauri↔engine
// session token (security.ts) — unrelated auth layers, both must hold.

cloud.get("/engine/cloud/config", (c) =>
  c.json({ enabled: Boolean(CLOUD_API_URL), mode: cloudMode(), webUrl: CLOUD_WEB_URL }),
);

cloud.get("/engine/cloud/session", (c) => {
  const session = loadCloudSession();
  return c.json({
    connected: Boolean(session),
    mode: session?.mode ?? null,
    userId: session?.userId ?? null,
    email: session?.email ?? null,
  });
});

cloud.post("/engine/cloud/login", async (c) => {
  if (!CLOUD_API_URL) return c.json({ error: "cloud sync is not configured" }, 409);
  if (cloudMode() === "supabase") {
    return c.json(
      { error: "supabase login is browser-based; call /engine/cloud/login/browser" },
      400,
    );
  }
  const body = await c.req.json<{ userId?: string }>();
  if (!body.userId?.trim()) {
    return c.json({ error: "userId is required (cloud is running in stub auth mode)" }, 400);
  }
  const userId = body.userId.trim();
  storeCloudSession({ mode: "stub", userId });
  // Prime the roster on sign-in so the desktop has a cloud-authoritative
  // workspace/project list to render (ADR 0015 §2). Best-effort — a failure
  // here doesn't block login; the desktop can retry via /roster/refresh.
  void refreshRoster().catch(() => {});
  return c.json({ connected: true, mode: "stub", userId });
});

// One pending browser login per install (desktop is single-user, ADR 0010).
let pendingLoginState: string | null = null;

cloud.post("/engine/cloud/login/browser", (c) => {
  if (!CLOUD_API_URL) return c.json({ error: "cloud sync is not configured" }, 409);
  if (cloudMode() !== "supabase") {
    return c.json({ error: "browser login is only used in supabase auth mode" }, 400);
  }
  const state = randomBytes(16).toString("hex");
  pendingLoginState = state;
  const url = `${CLOUD_WEB_URL}/login?desktop=1&state=${state}`;
  return c.json({ url, state });
});

cloud.post("/engine/cloud/login/redeem", async (c) => {
  if (!CLOUD_API_URL) return c.json({ error: "cloud sync is not configured" }, 409);
  const body = await c.req.json<{ code?: string; state?: string }>();
  if (!body.code?.trim() || !body.state?.trim()) {
    return c.json({ error: "code and state are required" }, 400);
  }
  if (!pendingLoginState || body.state !== pendingLoginState) {
    return c.json({ error: "unexpected or expired login state" }, 400);
  }
  pendingLoginState = null; // consume regardless of outcome
  try {
    const { accessToken, refreshToken, userId } = await redeemDesktopCode(body.code.trim());
    const email = emailFromAccessToken(accessToken);
    storeCloudSession({ mode: "supabase", userId, email }, accessToken, refreshToken);
    void refreshRoster().catch(() => {}); // prime roster on sign-in (ADR 0015 §2)
    return c.json({ connected: true, mode: "supabase", userId, email: email ?? null });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
});

cloud.post("/engine/cloud/logout", (c) => {
  // clearCloudSession() also scrubs the roster cache (ADR 0015 §3.4) so
  // workspace/project names don't leak to the next user of the machine.
  clearCloudSession();
  return c.json({ ok: true });
});

// --- Roster cache (ADR 0015 §2, plan 0006 G2) ------------------------------
// The cloud-authoritative roster is mirrored locally so the desktop renders
// fully offline. Reuses the existing member-scoped GET /workspaces + GET
// /projects — no new cloud endpoint (ADR 0015 decision: none in v1).

async function refreshRoster(): Promise<{ workspaces: RosterWorkspace[]; projects: RosterProject[] }> {
  // apps/cloud returns bare arrays (response_model=list[...]). Keep metadata
  // only — id/name/workspace_id — never anything secret (ADR 0010 §5).
  const rawWorkspaces = await cloudFetch<{ id: string; name: string }[]>("/workspaces");
  const rawProjects = await cloudFetch<{ id: string; name: string; workspace_id: string }[]>(
    "/projects",
  );
  const workspaces: RosterWorkspace[] = rawWorkspaces.map((w) => ({ id: w.id, name: w.name }));
  const projects: RosterProject[] = rawProjects.map((p) => ({
    id: p.id,
    name: p.name,
    workspace_id: p.workspace_id,
  }));
  storeRoster(workspaces, projects);
  return { workspaces, projects };
}

// Read the cached roster. No network — renders offline from the last sync
// (plan 0006 G2: "no live network check required to read it").
cloud.get("/engine/cloud/roster", (c) =>
  c.json({
    workspaces: loadRosterWorkspaces(),
    projects: loadRosterProjects(),
    syncedAt: rosterSyncedAt(),
  }),
);

// Refresh from the cloud (called on sign-in, on app focus, on explicit
// refresh). Offline, it falls back to the cached roster with offline:true so
// the desktop can still render and distinguish "cloud unreachable" from
// "signed out" (ADR 0015 state 4).
cloud.post("/engine/cloud/roster/refresh", async (c) => {
  if (!loadCloudSession()) return c.json({ error: "not logged in to PromptConnext Cloud" }, 401);
  try {
    const { workspaces, projects } = await refreshRoster();
    return c.json({ workspaces, projects, syncedAt: rosterSyncedAt(), offline: false });
  } catch (err) {
    return c.json({
      workspaces: loadRosterWorkspaces(),
      projects: loadRosterProjects(),
      syncedAt: rosterSyncedAt(),
      offline: true,
      error: (err as Error).message,
    });
  }
});

// Find the local project bound to a given cloud project id, if any.
function findLocalProjectByCloudId(cloudProjectId: string): string | null {
  const rows = db
    .prepare("SELECT project_id, config FROM integrations WHERE kind = 'cloud'")
    .all() as { project_id: string; config: string | null }[];
  for (const r of rows) {
    if (!r.config) continue;
    try {
      const cfg = JSON.parse(r.config) as { project_id?: string };
      if (cfg.project_id === cloudProjectId) return r.project_id;
    } catch {
      // ignore malformed link config
    }
  }
  return null;
}

// Open a roster project on this machine: if it already has a local graph,
// return its local id; otherwise materialize a local project shell and
// full-graph bootstrap-pull the cloud's merged state into it (ADR 0015 §2,
// state 9 "new device"). The task graph stays local-authoritative afterward —
// this is a one-shot hydrate, not an ongoing merge.
cloud.post("/engine/cloud/projects/:cloudProjectId/open", async (c) => {
  if (!loadCloudSession()) return c.json({ error: "not logged in to PromptConnext Cloud" }, 401);
  const cloudProjectId = c.req.param("cloudProjectId");

  const existing = findLocalProjectByCloudId(cloudProjectId);
  if (existing) return c.json({ localProjectId: existing, hydrated: false });

  const rosterProject = loadRosterProjects().find((p) => p.id === cloudProjectId);
  if (!rosterProject) return c.json({ error: "project not in roster (refresh first)" }, 404);

  // The desktop offers a folder picker on first open (plan: docs/superpowers/
  // plans/2026-07-19-desktop-local-project-path.md); omitted, this falls back
  // to createLocalProjectShell's own default root, same as before.
  const { path } = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });

  let local: ReturnType<typeof createLocalProjectShell>;
  try {
    local = createLocalProjectShell(rosterProject.name, path?.trim() || undefined);
  } catch (err) {
    const message = (err as Error).message;
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({ error: "That folder is already used by another project." }, 409);
    }
    return c.json({ error: message }, 500);
  }

  writeCloudLink(local.id, { workspace_id: rosterProject.workspace_id, project_id: cloudProjectId });
  try {
    const result = await hydrateProjectGraph(local.id, cloudProjectId);
    return c.json({ localProjectId: local.id, hydrated: true, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

cloud.get("/engine/cloud/workspaces", async (c) => {
  try {
    // apps/cloud returns a bare array (response_model=list[Workspace]) —
    // normalize to { workspaces: [...] } to match this route's other shapes.
    const workspaces = await cloudFetch<unknown[]>("/workspaces");
    return c.json({ workspaces });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

cloud.post("/engine/cloud/workspaces", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  try {
    const data = await cloudFetch<unknown>("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: body.name.trim() }),
    });
    return c.json(data);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

cloud.get("/engine/cloud/active-workspace", (c) => c.json(loadActiveWorkspace()));

cloud.put("/engine/cloud/active-workspace", async (c) => {
  const body = await c.req.json<{ id?: string }>();
  const id = body.id?.trim();
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    // Validate membership against the caller's cloud workspaces before storing.
    const workspaces = await cloudFetch<{ id: string; name: string }[]>("/workspaces");
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return c.json({ error: "not a member of that workspace" }, 400);
    const active: ActiveWorkspace = { id: ws.id, name: ws.name };
    storeActiveWorkspace(active);
    return c.json(active);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

cloud.delete("/engine/cloud/active-workspace", (c) => {
  clearActiveWorkspace();
  return c.json({ ok: true });
});

cloud.post("/engine/cloud/invitations/:token/accept", async (c) => {
  try {
    const data = await cloudFetch<unknown>(
      `/invitations/${encodeURIComponent(c.req.param("token"))}/accept`,
      { method: "POST" },
    );
    return c.json(data);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// --- Per-project cloud link ------------------------------------------------
// Stored in the existing `integrations` table (kind='cloud'); no schema
// migration needed beyond widening the kind CHECK constraint (db.ts).
// getCloudLink / writeCloudLink are shared with sync/loop.ts.

cloud.get("/engine/projects/:id/cloud-link", (c) => {
  const link = getCloudLink(c.req.param("id"));
  return c.json(link ? { linked: true, ...link } : { linked: false });
});

cloud.post("/engine/projects/:id/cloud-link", async (c) => {
  const projectId = c.req.param("id");
  const project = db.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as
    | { id: string; name: string }
    | undefined;
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = await c.req.json<{ workspaceId?: string; cloudProjectId?: string }>();
  const workspaceId = body.workspaceId?.trim() || loadActiveWorkspace()?.id;
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required (no active workspace set)" }, 400);
  }

  try {
    // Link to an existing cloud project if given, otherwise create one in the
    // chosen workspace and link to that.
    let cloudProjectId = body.cloudProjectId?.trim();
    if (!cloudProjectId) {
      const created = await cloudFetch<{ id: string }>("/projects", {
        method: "POST",
        body: JSON.stringify({ name: project.name, workspace_id: workspaceId }),
      });
      cloudProjectId = created.id;
    }

    const config = { workspace_id: workspaceId, project_id: cloudProjectId };
    writeCloudLink(projectId, config);
    return c.json({ linked: true, ...config });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

cloud.delete("/engine/projects/:id/cloud-link", (c) => {
  db.prepare("DELETE FROM integrations WHERE project_id = ? AND kind = 'cloud'").run(
    c.req.param("id"),
  );
  return c.json({ linked: false });
});

// --- Push sync (D2 push-only cut) ------------------------------------------

cloud.post("/engine/projects/:id/cloud-sync", async (c) => {
  const result = await pushProjectSnapshot(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 502);
});

cloud.get("/engine/projects/:id/cloud-sync", (c) =>
  c.json(lastSyncResult(c.req.param("id")) ?? { at: null, ok: null }),
);

// --- Discussions (M12) ------------------------------------------------------
// Local reads/writes only — sync happens via pushProjectSnapshot (up) and
// pullProjectDiscussions (down, sync/loop.ts), not directly from these routes.

type LocalDiscussion = {
  id: string;
  project_id: string;
  parent_node_type: string;
  parent_node_id: string;
  author: string;
  body: string;
  source: string;
  updated_at: string;
};

cloud.get("/engine/projects/:id/discussions", (c) => {
  const projectId = c.req.param("id");
  const parentNodeType = c.req.query("parentNodeType");
  const parentNodeId = c.req.query("parentNodeId");

  let query = "SELECT id, project_id, parent_node_type, parent_node_id, author, body, source, updated_at FROM discussions WHERE project_id = ? AND deleted_at IS NULL";
  const params: string[] = [projectId];
  if (parentNodeType && parentNodeId) {
    query += " AND parent_node_type = ? AND parent_node_id = ?";
    params.push(parentNodeType, parentNodeId);
  }
  query += " ORDER BY updated_at ASC";

  const rows = db.prepare(query).all(...params) as LocalDiscussion[];
  return c.json({ discussions: rows });
});

cloud.post("/engine/projects/:id/discussions", async (c) => {
  const projectId = c.req.param("id");
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = await c.req.json<{
    parentNodeType?: string;
    parentNodeId?: string;
    body?: string;
  }>();
  if (!body.parentNodeType?.trim() || !body.parentNodeId?.trim() || !body.body?.trim()) {
    return c.json({ error: "parentNodeType, parentNodeId, and body are required" }, 400);
  }

  // Desktop is single-user per install; the "author" identity is whichever
  // cloud user this install is logged in as (same identity pushed graph
  // data is implicitly attributed to), or a placeholder when unlinked.
  const author = loadCloudSession()?.userId ?? "local";
  const id = randomUUID();
  db.prepare(
    `INSERT INTO discussions (id, project_id, parent_node_type, parent_node_id, author, body, source)
     VALUES (?, ?, ?, ?, ?, ?, 'pz')`,
  ).run(id, projectId, body.parentNodeType.trim(), body.parentNodeId.trim(), author, body.body.trim());

  // Push immediately rather than waiting for the next interval tick —
  // comments should feel synchronous, not delayed up to CLOUD_SYNC_POLL_SECONDS.
  await pushProjectSnapshot(projectId).catch(() => {});

  const created = db
    .prepare(
      "SELECT id, project_id, parent_node_type, parent_node_id, author, body, source, updated_at FROM discussions WHERE id = ?",
    )
    .get(id) as LocalDiscussion;
  return c.json(created, 201);
});
