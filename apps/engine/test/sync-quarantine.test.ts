// A cloud link can outlive its cloud project — the project is deleted
// server-side, or the link was made against a different CLOUD_API_URL. The
// cloud then answers every push and pull with 404 project_not_found, and the
// interval loop used to retry it forever, flooding both logs and telling the
// user nothing. These tests pin the quarantine: a definitive 404 stamps the
// link broken, the loop skips broken links, and a later successful push lifts
// the quarantine again.
//
// Follows wp2-conflicts.test.ts's pattern: a tiny real `http.createServer` fake
// cloud, no mocking library, `node:test`. Env must be set before importing the
// SUT (db.ts + config.ts read it at import time).
//
// Run:  node --test apps/engine/test/sync-quarantine.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function drain(req: http.IncomingMessage): Promise<void> {
  for await (const _ of req) {
    /* discard */
  }
}

// --- Fake apps/cloud --------------------------------------------------------
// The graph endpoints 404 for every project id until `revived` flips, which
// lets one test observe the quarantine and the next observe it being lifted.
let revived = false;
const graphRequests: string[] = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  await drain(req);
  const graphMatch = url.pathname.match(/^\/sync\/projects\/([^/]+)\/graph$/);
  if (graphMatch) {
    graphRequests.push(`${req.method} ${graphMatch[1]}`);
    if (!revived) return send(404, { detail: "project_not_found" });
    return send(200, { upserted: { tasks: 0 }, cursor: null, conflicts: {}, discussions: [], tasks: [] });
  }
  return send(404, { detail: "not found" });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const dataDir = mkdtempSync(join(tmpdir(), "pz-quarantine-"));
process.env.HOME = dataDir;
process.env.PROMPTWORKSPACE_DATA_DIR = dataDir;
process.env.CLOUD_API_URL = `http://127.0.0.1:${port}`;
process.env.CLOUD_SYNC_POLL_SECONDS = "1";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTWORKSPACE_AUTH_TOKEN;

const { Hono } = await import("hono");
const { cloud: cloudRoutes } = await import("../src/routes/cloud.ts");
const { projects: projectRoutes } = await import("../src/routes/projects.ts");
const { pushProjectSnapshot, getCloudLink, writeCloudLink, startCloudSyncLoop, stopCloudSyncLoop } =
  await import("../src/sync/loop.ts");

const app = new Hono();
app.route("/", cloudRoutes);
app.route("/", projectRoutes);

const req = (path: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

async function createLocalProject(name: string): Promise<string> {
  const res = await req("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name, workspaceId: "ws-1" }),
  });
  const body = (await res.json()) as { id: string; error?: string };
  assert.equal(res.status, 200, body.error);
  return body.id;
}

let localProjectId = "";

test("a 404 from the cloud quarantines the link instead of failing anonymously", async () => {
  const login = await req("/engine/cloud/login", {
    method: "POST",
    body: JSON.stringify({ userId: "tester" }),
  });
  assert.equal(login.status, 200);

  localProjectId = await createLocalProject("Quarantine Test Project");
  writeCloudLink(localProjectId, { workspace_id: "ws-1", project_id: "cp-gone" });

  const result = await pushProjectSnapshot(localProjectId);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no longer exists/);

  const link = getCloudLink(localProjectId);
  assert.ok(link?.broken_at, "link is stamped broken");
  assert.equal(link?.project_id, "cp-gone", "the dead id is retained for the relink UI");
});

test("the interval loop skips a quarantined link", async () => {
  graphRequests.length = 0;
  startCloudSyncLoop();
  await new Promise((r) => setTimeout(r, 2_300)); // two ticks at CLOUD_SYNC_POLL_SECONDS=1
  stopCloudSyncLoop();
  assert.deepEqual(graphRequests, [], "no push or pull was attempted for the broken link");
});

test("a later successful push lifts the quarantine", async () => {
  revived = true;
  const result = await pushProjectSnapshot(localProjectId);
  assert.equal(result.ok, true, JSON.stringify(result));
  const link = getCloudLink(localProjectId);
  assert.ok(!link?.broken_at, "quarantine cleared");
  assert.equal(link?.project_id, "cp-gone", "link still points at the same cloud project");
});

test.after(() => {
  server.close();
});
