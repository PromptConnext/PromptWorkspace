// G2 (plan 0006) — engine roster cache + full-graph bootstrap-pull +
// clear-on-logout. Runs against a fake apps/cloud (a tiny in-process HTTP
// server) so no Python/network is needed. Exercises the real Hono route
// handlers via app.request(), the real SQLite store, and the real sync loop.
//
// Run:  node --test apps/engine/test/g2-roster.test.ts
// (env must be set BEFORE importing the SUT, so setup is top-level await.)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Fake apps/cloud --------------------------------------------------------
// Minimal implementation of the endpoints G2 consumes. Keyset-paginates the
// graph at PAGE=2 regardless of the requested limit, so a small seed still
// forces the engine's multi-page drain loop.
const PAGE = 2;

type Row = { etype: string; entity: Record<string, unknown>; updated_at: string; id: string };

const cloud = {
  failCreate: false, // toggled to simulate "offline" for POST /projects
  workspaces: [
    { id: "ws-1", name: "Acme" },
    { id: "ws-2", name: "Beta" },
  ] as { id: string; name: string }[],
  projects: [
    { id: "cp-remote", name: "Remote Project", workspace_id: "ws-1" },
  ] as { id: string; name: string; workspace_id: string }[],
  graphs: new Map<string, Row[]>(),
  pushed: [] as { projectId: string; body: unknown }[],
  createdProjects: [] as { id: string; name: string; workspace_id: string }[],
};

function seedGraph(projectId: string): void {
  const base = Date.parse("2026-07-18T00:00:00.000Z");
  const rows: Row[] = [];
  let i = 0;
  const ts = () => new Date(base + i++ * 1000).toISOString();
  const r1 = { id: "req-1", project_id: projectId, title: "R1", description: "d", status: "approved" };
  rows.push({ etype: "requirements", entity: r1, updated_at: ts(), id: r1.id });
  const s1 = { id: "spec-1", project_id: projectId, requirement_id: "req-1", content: "spec", version: 2, status: "approved", approved_by: "u1" };
  rows.push({ etype: "spec_documents", entity: s1, updated_at: ts(), id: s1.id });
  const t1 = { id: "task-1", project_id: projectId, spec_id: "spec-1", title: "T1", status: "implemented", feature_tag: "f", acceptance_criteria: [{ text: "ac-a" }, { text: "ac-b" }] };
  rows.push({ etype: "tasks", entity: t1, updated_at: ts(), id: t1.id });
  const a1 = { id: "art-1", project_id: projectId, task_id: "task-1", kind: "code", uri: "file://x", commit_sha: "abc" };
  rows.push({ etype: "artifacts", entity: a1, updated_at: ts(), id: a1.id });
  const ar1 = { id: "run-1", project_id: projectId, task_id: "task-1", model_role: "code", action: "implement", status: "done", evidence: { note: "did it" } };
  rows.push({ etype: "agent_runs", entity: ar1, updated_at: ts(), id: ar1.id });
  cloud.graphs.set(projectId, rows);
}

function pageGraph(projectId: string, url: URL): Record<string, unknown> {
  const all = (cloud.graphs.get(projectId) ?? []).slice().sort((x, y) =>
    x.updated_at === y.updated_at ? (x.id < y.id ? -1 : 1) : x.updated_at < y.updated_at ? -1 : 1,
  );
  const afterTs = url.searchParams.get("after_ts");
  const afterId = url.searchParams.get("after_id");
  const remaining = all.filter((row) => {
    if (!afterTs) return true;
    if (row.updated_at < afterTs) return false;
    if (row.updated_at === afterTs && afterId !== null && row.id <= afterId) return false;
    return true;
  });
  const pageRows = remaining.slice(0, PAGE);
  const hasMore = remaining.length > PAGE;
  const last = pageRows[pageRows.length - 1];
  const out: Record<string, unknown> = {
    requirements: [], spec_documents: [], tasks: [], artifacts: [], agent_runs: [], discussions: [],
    cursor: last ? last.updated_at : null,
    next_id: hasMore && last ? last.id : null,
    has_more: hasMore,
  };
  for (const row of pageRows) (out[row.etype] as unknown[]).push(row.entity);
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const graphMatch = url.pathname.match(/^\/sync\/projects\/([^/]+)\/graph$/);

  if (url.pathname === "/workspaces" && req.method === "GET") return send(200, cloud.workspaces);
  if (url.pathname === "/projects" && req.method === "GET") return send(200, cloud.projects);
  if (url.pathname === "/projects" && req.method === "POST") {
    if (cloud.failCreate) return send(503, { error: "offline" });
    const body = (await readBody(req)) as { name: string; workspace_id: string };
    const created = { id: `cp-${cloud.createdProjects.length + 1}`, name: body.name, workspace_id: body.workspace_id };
    cloud.createdProjects.push(created);
    cloud.projects.push(created);
    return send(201, created);
  }
  if (graphMatch && req.method === "GET") return send(200, pageGraph(graphMatch[1], url));
  if (graphMatch && req.method === "PUT") {
    cloud.pushed.push({ projectId: graphMatch[1], body: await readBody(req) });
    return send(200, { upserted: {}, cursor: null });
  }
  return send(404, { error: "not found" });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

// Env MUST be set before importing the SUT (db.ts + config.ts read it at import).
const dataDir = mkdtempSync(join(tmpdir(), "pz-g2-"));
process.env.HOME = dataDir; // keep createLocalProjectShell's project dirs out of the real homedir
process.env.PROMPTCONNEXT_DATA_DIR = dataDir;
process.env.CLOUD_API_URL = `http://127.0.0.1:${port}`;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTCONNEXT_AUTH_TOKEN;

const { Hono } = await import("hono");
const { cloud: cloudRoutes } = await import("../src/routes/cloud.ts");
const { projects: projectRoutes } = await import("../src/routes/projects.ts");
const { db } = await import("../src/db.ts");
const { loadRosterWorkspaces, loadRosterProjects } = await import("../src/cloudClient.ts");
const { pushProjectSnapshot, getCloudLink } = await import("../src/sync/loop.ts");

const app = new Hono();
app.route("/", cloudRoutes);
app.route("/", projectRoutes);

const req = (path: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

async function loginStub(userId = "tester"): Promise<void> {
  const res = await req("/engine/cloud/login", { method: "POST", body: JSON.stringify({ userId }) });
  assert.equal(res.status, 200);
  // login fires roster refresh in the background; wait for it to land.
  for (let i = 0; i < 50 && loadRosterWorkspaces().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- Tests ------------------------------------------------------------------

test("roster cache renders the last-known workspaces/projects fully offline", async () => {
  await loginStub();
  assert.equal(loadRosterWorkspaces().length, 2, "roster primed on sign-in");

  // Force the cloud offline: no live network call is allowed to read the cache.
  await new Promise<void>((r) => server.close(() => r()));

  const res = await req("/engine/cloud/roster");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    workspaces: { name: string }[];
    projects: { name: string }[];
    syncedAt: string | null;
  };
  assert.deepEqual(body.workspaces.map((w) => w.name), ["Acme", "Beta"]);
  assert.deepEqual(body.projects.map((p) => p.name), ["Remote Project"]);
  assert.ok(body.syncedAt, "records when the roster was last synced");

  // Reopen the server for the remaining tests.
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
});

test("opening a cloud project absent locally hydrates its full graph, draining >1 page", async () => {
  seedGraph("cp-remote");
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const res = await req("/engine/cloud/projects/cp-remote/open", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    localProjectId: string;
    hydrated: boolean;
    pages: number;
    counts: Record<string, number>;
  };
  assert.equal(body.hydrated, true);
  assert.ok(body.pages > 1, `expected a multi-page drain, got ${body.pages} page(s)`);
  assert.equal(body.counts.requirements, 1);
  assert.equal(body.counts.tasks, 1);
  assert.equal(body.counts.agent_runs, 1);

  // The cloud's merged state is now a local replica (same id space).
  const localId = body.localProjectId;
  const reqRow = db.prepare("SELECT status FROM requirements WHERE id='req-1'").get() as { status: string };
  assert.equal(reqRow.status, "approved");
  const taskRow = db.prepare("SELECT status FROM tasks WHERE id='task-1'").get() as { status: string };
  assert.equal(taskRow.status, "done", "cloud 'implemented' maps back to local 'done'");
  const acCount = db.prepare("SELECT COUNT(*) n FROM acceptance_criteria WHERE task_id='task-1'").get() as { n: number };
  assert.equal(acCount.n, 2, "embedded acceptance_criteria replicated");
  const runRow = db.prepare("SELECT evidence, project_id FROM agent_runs WHERE id='run-1'").get() as { evidence: string; project_id: string };
  assert.equal(runRow.evidence, "did it", "evidence dict unwrapped to local free text");
  assert.equal(runRow.project_id, localId);

  // Re-opening does NOT re-bootstrap (it already has a local graph).
  const again = await req("/engine/cloud/projects/cp-remote/open", { method: "POST" });
  const againBody = (await again.json()) as { hydrated: boolean; localProjectId: string };
  assert.equal(againBody.hydrated, false);
  assert.equal(againBody.localProjectId, localId);
});

test("G4: GET /engine/projects surfaces cloud_project_id for a linked project", async () => {
  // The prior test opened cp-remote, which links a local project to that cloud
  // project id. Surfacing it lets the desktop dedupe roster tabs precisely by
  // id instead of by name (plan 0006 G4, resolving G3's duplicate-name gap).
  const res = await req("/engine/projects");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    projects: { id: string; cloud_workspace_id: string | null; cloud_project_id: string | null }[];
  };
  const linked = body.projects.find((p) => p.cloud_project_id === "cp-remote");
  assert.ok(linked, "the opened cloud project surfaces its cloud_project_id");
  assert.equal(linked.cloud_workspace_id, "ws-1", "workspace id still surfaced alongside");
});

test("creating a project without an active workspace is rejected with a clear error", async () => {
  await req("/engine/cloud/active-workspace", { method: "DELETE" }); // ensure none active
  const res = await req("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name: "No WS", path: join(dataDir, "no-ws") }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /active workspace is required/i);
});

test("offline-created project is pending-sync and flushes on reconnect (no data loss)", async () => {
  // Active workspace set, but the cloud is 'offline' for project creation.
  await req("/engine/cloud/active-workspace", {
    method: "PUT",
    body: JSON.stringify({ id: "ws-1" }),
  });
  cloud.failCreate = true;

  const res = await req("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Offline Born", path: join(dataDir, "offline-born") }),
  });
  assert.equal(res.status, 200);
  const { id: localId } = (await res.json()) as { id: string };

  // Linked to the workspace, but pending (no cloud project id yet).
  const pending = getCloudLink(localId);
  assert.equal(pending?.workspace_id, "ws-1");
  assert.ok(!pending?.project_id, "cloud project is pending while offline");

  // A push while still offline stays pending, no crash, no data loss.
  cloud.failCreate = true;
  const stillPending = await pushProjectSnapshot(localId);
  assert.equal(stillPending.ok, false);
  assert.ok(!getCloudLink(localId)?.project_id);

  // Reconnect: the next push mints the cloud project and flushes.
  cloud.failCreate = false;
  const flushed = await pushProjectSnapshot(localId);
  assert.equal(flushed.ok, true);
  const link = getCloudLink(localId);
  assert.ok(link?.project_id, "cloud project materialized on reconnect");
  assert.ok(cloud.pushed.some((p) => p.projectId === link!.project_id), "graph pushed after flush");
});

test("logout clears the roster cache (no workspace/project names readable afterward)", async () => {
  assert.ok(loadRosterWorkspaces().length > 0, "roster present before logout");
  const res = await req("/engine/cloud/logout", { method: "POST" });
  assert.equal(res.status, 200);

  assert.equal(loadRosterWorkspaces().length, 0, "workspace names scrubbed");
  assert.equal(loadRosterProjects().length, 0, "project names scrubbed");

  const rosterRes = await req("/engine/cloud/roster");
  const body = (await rosterRes.json()) as { workspaces: unknown[]; projects: unknown[] };
  assert.deepEqual(body.workspaces, []);
  assert.deepEqual(body.projects, []);
});

test.after(() => {
  server.close();
});
