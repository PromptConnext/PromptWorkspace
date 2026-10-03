// WP2 (docs/plans — sync conflict visibility): the cloud's field-level merge
// silently dropped fields that failed the ownership gate or were stale under
// LWW. This test asserts pushProjectSnapshot() threads the cloud's new
// `conflicts` field on GraphUpsertResponse through into the stored SyncResult,
// so the desktop UI has something to warn on instead of data loss vanishing
// with zero signal.
//
// Follows g2-roster.test.ts's pattern: a tiny real `http.createServer` fake
// cloud, no mocking library, `node:test`. Env must be set before importing the
// SUT (db.ts + config.ts read it at import time).
//
// Run:  node --test apps/engine/test/wp2-conflicts.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// --- Fake apps/cloud --------------------------------------------------------
// Only the two endpoints this test exercises: project creation (to mint a
// cloud project for the link) and the graph push, whose response carries a
// fixed `conflicts` payload to simulate a losing write.
const CONFLICTS = { "task-1": ["status", "spec_id"] };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/projects" && req.method === "POST") {
    const body = (await readBody(req)) as { name: string; workspace_id: string };
    return send(201, { id: "cp-1", name: body.name, workspace_id: body.workspace_id });
  }
  const graphMatch = url.pathname.match(/^\/sync\/projects\/([^/]+)\/graph$/);
  if (graphMatch && req.method === "PUT") {
    await readBody(req);
    return send(200, { upserted: { tasks: 1 }, cursor: null, conflicts: CONFLICTS });
  }
  return send(404, { error: "not found" });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

// Env MUST be set before importing the SUT (db.ts + config.ts read it at import).
const dataDir = mkdtempSync(join(tmpdir(), "pz-wp2-"));
process.env.HOME = dataDir;
process.env.PROMPTWORKSPACE_DATA_DIR = dataDir;
process.env.CLOUD_API_URL = `http://127.0.0.1:${port}`;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTWORKSPACE_AUTH_TOKEN;

const { Hono } = await import("hono");
const { cloud: cloudRoutes } = await import("../src/routes/cloud.ts");
const { projects: projectRoutes } = await import("../src/routes/projects.ts");
const { pushProjectSnapshot, writeCloudLink } = await import("../src/sync/loop.ts");

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
}

async function createLocalProject(name: string): Promise<string> {
  const res = await req("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name, workspaceId: "ws-1" }),
  });
  const body = (await res.json()) as { id: string; error?: string };
  assert.equal(res.status, 200, body.error);
  return body.id;
}

test("pushProjectSnapshot surfaces the cloud response's conflicts into the stored SyncResult", async () => {
  await loginStub();
  const localProjectId = await createLocalProject("WP2 Test Project");
  // Link straight to a minted cloud project id, bypassing the workspace picker
  // UI flow — only the push path is under test here.
  writeCloudLink(localProjectId, { workspace_id: "ws-1", project_id: "cp-1" });

  const result = await pushProjectSnapshot(localProjectId);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.conflicts, CONFLICTS);

  const { lastSyncResult } = await import("../src/sync/loop.ts");
  const stored = lastSyncResult(localProjectId);
  assert.ok(stored, "sync result was persisted");
  assert.deepEqual(stored?.conflicts, CONFLICTS, "conflicts survive the recordResult round-trip");
});

test.after(() => {
  server.close();
});
