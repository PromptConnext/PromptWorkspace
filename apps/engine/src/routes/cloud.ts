import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { CLOUD_API_URL, CLOUD_WEB_URL } from "../config.ts";
import {
  cloudFetch,
  cloudMode,
  clearCloudSession,
  loadCloudSession,
  redeemDesktopCode,
  storeCloudSession,
} from "../cloudClient.ts";
import { lastSyncResult, pushProjectSnapshot } from "../sync/loop.ts";

export const cloud = new Hono();

// D1 (docs/plans/0004): auth + workspace linking. The engine talks to
// apps/cloud as a real cloud identity, separate from the local Tauri↔engine
// session token (security.ts) — unrelated auth layers, both must hold.

cloud.get("/engine/cloud/config", (c) =>
  c.json({ enabled: Boolean(CLOUD_API_URL), mode: cloudMode() }),
);

cloud.get("/engine/cloud/session", (c) => {
  const session = loadCloudSession();
  return c.json({
    connected: Boolean(session),
    mode: session?.mode ?? null,
    userId: session?.userId ?? null,
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
  const body = await c.req.json<{ code?: string; state?: string }>();
  if (!body.code?.trim() || !body.state?.trim()) {
    return c.json({ error: "code and state are required" }, 400);
  }
  if (!pendingLoginState || body.state !== pendingLoginState) {
    return c.json({ error: "unexpected or expired login state" }, 400);
  }
  pendingLoginState = null; // consume regardless of outcome
  try {
    const { accessToken, userId } = await redeemDesktopCode(body.code.trim());
    storeCloudSession({ mode: "supabase", userId }, accessToken);
    return c.json({ connected: true, mode: "supabase", userId });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
});

cloud.post("/engine/cloud/logout", (c) => {
  clearCloudSession();
  return c.json({ ok: true });
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

type CloudLinkConfig = { workspace_id: string; project_id: string };

function getCloudLink(projectId: string): CloudLinkConfig | null {
  const row = db
    .prepare("SELECT config FROM integrations WHERE project_id = ? AND kind = 'cloud'")
    .get(projectId) as { config: string | null } | undefined;
  return row?.config ? (JSON.parse(row.config) as CloudLinkConfig) : null;
}

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
  if (!body.workspaceId?.trim()) return c.json({ error: "workspaceId is required" }, 400);

  try {
    // Link to an existing cloud project if given, otherwise create one in the
    // chosen workspace and link to that.
    let cloudProjectId = body.cloudProjectId?.trim();
    if (!cloudProjectId) {
      const created = await cloudFetch<{ id: string }>("/projects", {
        method: "POST",
        body: JSON.stringify({ name: project.name, workspace_id: body.workspaceId }),
      });
      cloudProjectId = created.id;
    }

    const config: CloudLinkConfig = { workspace_id: body.workspaceId, project_id: cloudProjectId };
    const existing = db
      .prepare("SELECT id FROM integrations WHERE project_id = ? AND kind = 'cloud'")
      .get(projectId) as { id: string } | undefined;
    if (existing) {
      db.prepare("UPDATE integrations SET config = ? WHERE id = ?").run(
        JSON.stringify(config),
        existing.id,
      );
    } else {
      db.prepare(
        "INSERT INTO integrations (id, project_id, kind, config, required) VALUES (?, ?, 'cloud', ?, 0)",
      ).run(randomUUID(), projectId, JSON.stringify(config));
    }
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
