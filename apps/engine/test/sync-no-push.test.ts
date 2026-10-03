// Plan 0012 M1 (ADR 0020): the interval sync loop used to push a full local
// graph snapshot to the cloud every tick, even for a healthy, already-linked
// project — overwriting cloud-authored planning state with whatever the
// local cache happened to hold. This test pins the fix: with a healthy link,
// the interval only ever reads the cloud's graph (GET), and never writes to
// it (PUT). sync-quarantine.test.ts already covers the broken-link case
// (skip everything); this covers the common case (pull only).
//
// Follows sync-quarantine.test.ts's pattern: a tiny real `http.createServer`
// fake cloud, no mocking library, `node:test`. Env must be set before
// importing the SUT (db.ts + config.ts read it at import time).
//
// Run:  node --test apps/engine/test/sync-no-push.test.ts
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
// Always healthy: every request against the graph endpoint succeeds, so
// nothing here can be quarantined. `graphRequests` records `METHOD` only —
// the method is exactly what M1 is about, the path is fixed by the route.
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
    graphRequests.push(req.method ?? "UNKNOWN");
    if (req.method === "PUT") {
      return send(200, { upserted: {}, cursor: null, conflicts: {} });
    }
    // GET: the shape pullProjectDiscussions and pullProjectTaskAssignments
    // each expect out of the same endpoint.
    return send(200, { discussions: [], tasks: [], cursor: null });
  }
  return send(404, { detail: "not found" });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const dataDir = mkdtempSync(join(tmpdir(), "pz-no-push-"));
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
const { writeCloudLink, startCloudSyncLoop, stopCloudSyncLoop } = await import("../src/sync/loop.ts");

const app = new Hono();
app.route("/", cloudRoutes);
app.route("/", projectRoutes);

const req = (path: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

test("a healthy link is pulled, never pushed, by the interval loop", async () => {
  const login = await req("/engine/cloud/login", {
    method: "POST",
    body: JSON.stringify({ userId: "tester" }),
  });
  assert.equal(login.status, 200);

  const createRes = await req("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name: "No-Push Test Project", workspaceId: "ws-1" }),
  });
  const created = (await createRes.json()) as { id: string; error?: string };
  assert.equal(createRes.status, 200, created.error);
  writeCloudLink(created.id, { workspace_id: "ws-1", project_id: "cp-healthy" });

  graphRequests.length = 0;
  startCloudSyncLoop();
  await new Promise((r) => setTimeout(r, 2_300)); // two ticks at CLOUD_SYNC_POLL_SECONDS=1
  stopCloudSyncLoop();

  assert.ok(graphRequests.length > 0, "the interval did read the graph at least once");
  assert.ok(
    graphRequests.every((m) => m === "GET"),
    `expected only GET requests, got: ${JSON.stringify(graphRequests)}`,
  );
});

test.after(() => {
  server.close();
});
