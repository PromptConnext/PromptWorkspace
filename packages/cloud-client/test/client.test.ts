// Run:  node --test packages/cloud-client/test/client.test.ts
//
// Same strategy as apps/engine's suite: no mocking library, a real
// http.createServer on port 0 standing in for the cloud, and the code under
// test genuinely making requests. The refresh coalescing in particular is only
// meaningful when two calls really do race.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CloudClient } from "../src/client.ts";
import { CloudHttpError, CloudNotLoggedInError } from "../src/errors.ts";
import {
  SessionStore,
  fileLeaseStorage,
  type LeaseStorageLike,
  type RefreshLease,
  type SecretsLike,
  type StorageLike,
} from "../src/session.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, fn: (base: string) => Promise<void>) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function memorySecrets(): SecretsLike {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key);
    },
    async store(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function memoryState(): StorageLike {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async update(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeClient(base: string, supabase?: string) {
  const session = new SessionStore(memorySecrets(), memoryState());
  const client = new CloudClient({
    session,
    config: () => ({
      apiUrl: base,
      supabaseUrl: supabase ?? "",
      supabaseAnonKey: supabase ? "anon-key" : "",
    }),
    fetch: (input, init) => fetch(input, init),
    log: silentLog,
  });
  return { client, session };
}

test("refuses to call the cloud when signed out", async () => {
  await withServer(
    (_req, res) => res.end("{}"),
    async (base) => {
      const { client } = makeClient(base);
      await assert.rejects(() => client.listAssignedTasks(), CloudNotLoggedInError);
    },
  );
});

test("stub mode identifies with X-User-Id, the header the cloud reads", async () => {
  let seen: string | undefined;
  await withServer(
    (req, res) => {
      seen = req.headers["x-user-id"] as string | undefined;
      res.setHeader("content-type", "application/json");
      res.end("[]");
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("alice");
      assert.deepEqual(await client.listAssignedTasks(), []);
      assert.equal(seen, "alice");
    },
  );
});

test("surfaces the cloud's own error code, with its status", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "status_forbidden" }));
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("bob");
      await assert.rejects(
        () => client.patchTaskStatus("p", "t", { status: "implemented" }),
        (err: unknown) => {
          assert.ok(err instanceof CloudHttpError);
          assert.equal(err.status, 403);
          assert.equal(err.message, "status_forbidden");
          return true;
        },
      );
    },
  );
});

test("a non-JSON error still yields a CloudHttpError carrying the status", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 502;
      res.end("<html>bad gateway</html>");
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("bob");
      await assert.rejects(
        () => client.listAssignedTasks(),
        (err: unknown) => err instanceof CloudHttpError && err.status === 502,
      );
    },
  );
});

test("builds the assigned-task query the cloud expects", async () => {
  let url: string | undefined;
  await withServer(
    (req, res) => {
      url = req.url;
      res.setHeader("content-type", "application/json");
      res.end("[]");
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("alice");
      await client.listAssignedTasks({
        workspaceId: "ws1",
        statuses: ["todo", "in_progress"],
        limit: 50,
      });
      // `status` repeats — FastAPI reads it as a list (app/api/me.py), so it
      // must not be collapsed into one comma-joined value.
      assert.equal(
        url,
        "/me/tasks?workspace_id=ws1&status=todo&status=in_progress&limit=50",
      );
    },
  );
});

test("writes status through the single-field route, never the graph push", async () => {
  const seen: { url?: string; method?: string; body?: string } = {};
  await withServer(
    (req, res) => {
      seen.url = req.url;
      seen.method = req.method;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.body = body;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "t1", status: "implemented" }));
      });
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("alice");
      await client.patchTaskStatus("p1", "t1", {
        status: "implemented",
        artifact: { commit_sha: "abc", uri: "git: T1", kind: "code" },
      });
      assert.equal(seen.method, "PATCH");
      assert.equal(seen.url, "/projects/p1/tasks/t1/status");
      assert.match(seen.body ?? "", /"commit_sha":"abc"/);
    },
  );
});

test("redeeming a code stores the session and decodes the email for display", async () => {
  const payload = Buffer.from(JSON.stringify({ email: "dev@example.com" })).toString(
    "base64url",
  );
  const accessToken = `header.${payload}.signature`;
  await withServer(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "r1",
          user_id: "user-1",
        }),
      );
    },
    async (base) => {
      const { client, session } = makeClient(base);
      const result = await client.redeemDesktopCode("code-1");
      assert.equal(result.userId, "user-1");
      assert.equal(result.email, "dev@example.com");
      assert.equal(session.read()?.mode, "supabase");
      assert.equal(await session.refreshToken(), "r1");
    },
  );
});

test("a 401 refreshes once and retries, and parallel calls share one refresh", async () => {
  // Supabase rotates the refresh token, so a second concurrent refresh would
  // fail invalid_grant and sign a valid session out. This is the regression.
  let refreshes = 0;
  let issued = 0;
  await withServer(
    (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        refreshes += 1;
        issued += 1;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ access_token: `access-${issued}`, refresh_token: `r${issued}` }),
        );
        return;
      }
      const auth = req.headers.authorization;
      if (auth !== "Bearer access-1") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ detail: "invalid_token" }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end("[]");
    },
    async (base) => {
      const { client, session } = makeClient(base, base);
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");

      const [a, b] = await Promise.all([
        client.listAssignedTasks(),
        client.listAssignedTasks(),
      ]);
      assert.deepEqual(a, []);
      assert.deepEqual(b, []);
      assert.equal(refreshes, 1, "both 401s shared the single in-flight refresh");
    },
  );
});

test("a definitively rejected refresh signs out; the session does not linger", async () => {
  await withServer(
    (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const { client, session } = makeClient(base, base);
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");
      await assert.rejects(() => client.listAssignedTasks());
      assert.equal(session.read(), null);
    },
  );
});

test("a refresh rejected because another window already rotated the token does not sign out", async () => {
  // Every editor window shares one SecretStorage and refreshes at once after a
  // sign-in. The loser is told refresh_token_not_found; the winner has already
  // stored its new pair. Signing out here deleted the winner's session too.
  let session!: SessionStore;
  await withServer(
    async (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        await session.store({ mode: "supabase", userId: "u1" }, "access-2", "r2");
        res.statusCode = 400;
        res.end(JSON.stringify({ code: 400, error_code: "refresh_token_not_found" }));
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer access-2") {
        res.end("[]");
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const made = makeClient(base, base);
      session = made.session;
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");

      assert.deepEqual(await made.client.listAssignedTasks(), []);
      assert.equal(session.read()?.userId, "u1", "the winner's session must survive");
      assert.equal(await session.refreshToken(), "r2");
    },
  );
});

test("a winner that stores a moment after the rejection is still adopted", async () => {
  let session!: SessionStore;
  await withServer(
    (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        // The other window's store lands ~250 ms after our rejection.
        setTimeout(() => {
          void session.store({ mode: "supabase", userId: "u1" }, "access-2", "r2");
        }, 250);
        res.statusCode = 400;
        res.end(JSON.stringify({ error_code: "refresh_token_not_found" }));
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer access-2") {
        res.end("[]");
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const made = makeClient(base, base);
      session = made.session;
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");
      assert.deepEqual(await made.client.listAssignedTasks(), []);
      assert.equal(session.read()?.userId, "u1");
    },
  );
});

test("a rotated refresh token with no usable access token yet is not a sign-out", async () => {
  let session!: SessionStore;
  await withServer(
    async (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        // Refresh token rotated, access token still the stale one.
        await session.store({ mode: "supabase", userId: "u1" }, undefined, "r2");
        res.statusCode = 400;
        res.end(JSON.stringify({ error_code: "refresh_token_not_found" }));
        return;
      }
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const made = makeClient(base, base);
      session = made.session;
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");
      await assert.rejects(() => made.client.listAssignedTasks());
      assert.equal(session.read()?.userId, "u1", "must not sign the other window out");
      assert.equal(await session.refreshToken(), "r2");
    },
  );
});

test("a 429 from the auth server does NOT sign the user out", async () => {
  await withServer(
    (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error_code: "over_request_rate_limit" }));
        return;
      }
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const { client, session } = makeClient(base, base);
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");
      await assert.rejects(() => client.listAssignedTasks());
      assert.equal(session.read()?.userId, "u1", "rate limiting is transient");
      assert.equal(await session.refreshToken(), "r0");
    },
  );
});

test("a 401 for a token another window has already replaced skips the refresh", async () => {
  let refreshes = 0;
  let session!: SessionStore;
  await withServer(
    async (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        refreshes += 1;
        res.statusCode = 400;
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer access-2") {
        res.end("[]");
        return;
      }
      // The first request carried the old token; meanwhile another window
      // stored a fresh pair.
      await session.store({ mode: "supabase", userId: "u1" }, "access-2", "r2");
      res.statusCode = 401;
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const made = makeClient(base, base);
      session = made.session;
      await session.store({ mode: "supabase", userId: "u1" }, "access-1", "r1");
      assert.deepEqual(await made.client.listAssignedTasks(), []);
      assert.equal(refreshes, 0, "the stored token was already newer");
    },
  );
});

test("clearIfRefreshToken leaves a session another window has since rotated", async () => {
  const { session } = makeClient("http://unused");
  await session.store({ mode: "supabase", userId: "u1" }, "a1", "r1");
  assert.equal(await session.clearIfRefreshToken("r0"), false);
  assert.equal(session.read()?.userId, "u1");
  assert.equal(await session.clearIfRefreshToken("r1"), true);
  assert.equal(session.read(), null);
});

test("a 5xx from the auth server does NOT sign the user out", async () => {
  await withServer(
    (req, res) => {
      if (req.url?.startsWith("/auth/v1/token")) {
        res.statusCode = 503;
        res.end("upstream down");
        return;
      }
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ detail: "invalid_token" }));
    },
    async (base) => {
      const { client, session } = makeClient(base, base);
      await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");
      await assert.rejects(() => client.listAssignedTasks());
      assert.equal(session.read()?.userId, "u1", "offline must not destroy the session");
    },
  );
});

test("reads the workspace roster from the two membership-gated routes", async () => {
  const calls: string[] = [];
  await withServer(
    (req, res) => {
      calls.push(req.url ?? "");
      const body = (req.url ?? "").endsWith("/workspaces")
        ? [{ id: "w1", name: "Acme Corp" }]
        : [{ id: "p1", name: "Checkout API", workspace_id: "w1", repo_url: null, lifecycle_status: "planning" }];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("alice");

      assert.deepEqual(await client.listWorkspaces(), [{ id: "w1", name: "Acme Corp" }]);
      const projects = await client.listWorkspaceProjects("w1");
      assert.equal(projects[0].name, "Checkout API");
      assert.deepEqual(calls, ["/workspaces", "/workspaces/w1/projects"]);
    },
  );
});

test("a workspace id is escaped into the projects path", async () => {
  const calls: string[] = [];
  await withServer(
    (req, res) => {
      calls.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end("[]");
    },
    async (base) => {
      const { client } = makeClient(base);
      await client.signInStub("alice");
      await client.listWorkspaceProjects("a b/c");
      assert.deepEqual(calls, ["/workspaces/a%20b%2Fc/projects"]);
    },
  );
});

// ------------------------------------------------------------ refresh lease
//
// Finding #50a: every editor window refreshes the shared session at the same
// moment, so N windows make N refresh calls per expiry and all but one lose
// the rotation. A lease lets one window refresh while the others re-read the
// secrets for the pair it stores. The lease is best-effort (shared editor
// storage has no compare-and-set), so every way it can go wrong must still end
// in one valid session — never a sign-out, never a 401.

type LeaseCell = { lease?: RefreshLease };

/** A lease store every window sees at once (one shared cell). */
function sharedLeases(): LeaseStorageLike {
  const cell: LeaseCell = {};
  return {
    async read() {
      return cell.lease;
    },
    async write(lease) {
      cell.lease = lease;
    },
  };
}

/** Two "windows": separate clients and SessionStores over one shared secret
 *  store, one shared state store and one shared lease store. */
function twoWindows(base: string, opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const secrets = memorySecrets();
  const state = memoryState();
  const leases = sharedLeases();
  const make = () => {
    const session = new SessionStore(secrets, state, leases);
    const client = new CloudClient({
      session,
      config: () => ({ apiUrl: base, supabaseUrl: base, supabaseAnonKey: "anon-key" }),
      fetch: (input, init) => fetch(input, init),
      log: silentLog,
      now: opts.now,
      sleep: opts.sleep,
    });
    return { client, session };
  };
  return { a: make(), b: make(), state, leases };
}

/** A Supabase stand-in that really rotates: each refresh token works once. */
function rotatingCloud() {
  let refreshes = 0;
  let current = "r0";
  let issued = 0;
  const handler: Handler = (req, res) => {
    if (req.url?.startsWith("/auth/v1/token")) {
      refreshes += 1;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const presented = (JSON.parse(body) as { refresh_token: string }).refresh_token;
        // Answer after a moment, as a real auth server does, so a second
        // window has time to collide with the first.
        setTimeout(() => {
          if (presented !== current) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error_code: "refresh_token_not_found" }));
            return;
          }
          issued += 1;
          current = `r${issued}`;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ access_token: `access-${issued}`, refresh_token: current }));
        }, 30);
      });
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === `Bearer access-${issued}` && issued > 0) {
      res.end("[]");
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ detail: "invalid_token" }));
  };
  return { handler, refreshes: () => refreshes, current: () => current };
}

test("two clients over one store make one refresh call", async () => {
  const cloud = rotatingCloud();
  await withServer(cloud.handler, async (base) => {
    const { a, b } = twoWindows(base);
    await a.session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");

    const [fromA, fromB] = await Promise.all([
      a.client.listAssignedTasks(),
      b.client.listAssignedTasks(),
    ]);
    assert.deepEqual(fromA, []);
    assert.deepEqual(fromB, []);
    assert.equal(cloud.refreshes(), 1, "one window refreshed; the other adopted its pair");
    assert.equal(a.session.read()?.userId, "u1");
    assert.equal(await b.session.refreshToken(), "r1");
  });
});

test("an expired lease is taken over", async () => {
  // A window that crashed mid-refresh leaves its lease behind. It must expire,
  // or one dead window stops every other window from ever refreshing.
  let t = 1_000_000;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  const cloud = rotatingCloud();
  await withServer(cloud.handler, async (base) => {
    const { a, leases } = twoWindows(base, { now, sleep });
    await a.session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");

    // Already expired: taken at once.
    await leases.write({ owner: "dead-window", until: t - 1 });
    assert.deepEqual(await a.client.listAssignedTasks(), []);
    assert.equal(cloud.refreshes(), 1);
    assert.equal(await leases.read(), undefined, "released after the refresh");

    // Live when we arrive, held by a window that never finishes: waited out
    // on the injected clock, then taken over.
    await a.session.store({ mode: "supabase", userId: "u1" }, "stale-again");
    await leases.write({ owner: "dead-window", until: t + 5_000 });
    const before = t;
    assert.deepEqual(await a.client.listAssignedTasks(), []);
    assert.equal(cloud.refreshes(), 2);
    assert.ok(t - before >= 5_000, "it waited for the lease to expire, not less");
  });
});

test("a lease that can never be won falls through to a refresh, not a sign-out", async () => {
  // Another window keeps renewing the lease and never stores a pair. Waiting
  // forever is wrong and so is giving up with a 401: refresh anyway and let
  // the rotation check decide.
  let t = 1_000_000;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  const cloud = rotatingCloud();
  await withServer(cloud.handler, async (base) => {
    const leases: LeaseStorageLike = {
      async read() {
        return { owner: "greedy-window", until: t + 60_000 };
      },
      async write() {
        /* the greedy window's lease always wins */
      },
    };
    const session = new SessionStore(memorySecrets(), memoryState(), leases);
    const client = new CloudClient({
      session,
      config: () => ({ apiUrl: base, supabaseUrl: base, supabaseAnonKey: "anon-key" }),
      fetch: (input, init) => fetch(input, init),
      log: silentLog,
      now,
      sleep,
    });
    await session.store({ mode: "supabase", userId: "u1" }, "stale", "r0");
    assert.deepEqual(await client.listAssignedTasks(), []);
    assert.equal(cloud.refreshes(), 1);
    assert.equal(session.read()?.userId, "u1");
  });
});

// The worst case of editor storage, modelled on VS Code's globalState: each
// window holds its own copy of one JSON blob, a write changes the local copy
// at once and reaches the other windows only after a delay — as the WHOLE
// object, replacing theirs, last arrival wins. Secrets are per key and shared.
// The lease store below behaves the same way, so the lease can be won by both
// windows (delivery slower than the read-back) or lost by both (both writes
// cross in flight). Time is scaled: a client's 200 ms sleep waits 20 ms.

function replicatedBlobs(deliveryMs: number) {
  const copies = new Map<string, Record<string, unknown>>();
  const window = (id: string) => {
    copies.set(id, {});
    return {
      get<T>(key: string): T | undefined {
        return copies.get(id)![key] as T | undefined;
      },
      async set(key: string, value: unknown) {
        const mine = { ...copies.get(id)! };
        if (value === undefined) delete mine[key];
        else mine[key] = value;
        copies.set(id, mine);
        const snapshot = structuredClone(mine);
        setTimeout(() => {
          for (const other of copies.keys()) {
            if (other !== id) copies.set(other, structuredClone(snapshot));
          }
        }, deliveryMs);
      },
    };
  };
  const seed = (key: string, value: unknown) => {
    for (const [id, blob] of copies) copies.set(id, { ...blob, [key]: value });
  };
  return { window, seed };
}

function replicatedWindows(base: string, deliveryMs: number) {
  let t = 1_000_000;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, ms / 10)));
  };
  const secrets = memorySecrets();
  const stateBlobs = replicatedBlobs(deliveryMs);
  const leaseBlobs = replicatedBlobs(deliveryMs);
  const make = (id: string) => {
    const stateCopy = stateBlobs.window(id);
    const leaseCopy = leaseBlobs.window(id);
    const state: StorageLike = { get: (key) => stateCopy.get(key), update: (key, value) => stateCopy.set(key, value) };
    const leases: LeaseStorageLike = {
      read: async () => leaseCopy.get<RefreshLease>("lease"),
      write: (lease) => leaseCopy.set("lease", lease),
    };
    const lost: string[] = [];
    const session = new SessionStore(secrets, state, leases);
    const client = new CloudClient({
      session,
      config: () => ({ apiUrl: base, supabaseUrl: base, supabaseAnonKey: "anon-key" }),
      fetch: (input, init) => fetch(input, init),
      log: {
        info: (m: string) => lost.push(m),
        warn: (m: string) => lost.push(m),
        error: (m: string) => lost.push(m),
      },
      now,
      sleep,
    });
    return { client, session, logs: lost, stateCopy };
  };
  const a = make("a");
  const b = make("b");
  return { a, b, secrets, stateBlobs };
}

async function bothWindowsRefresh(deliveryMs: number) {
  const cloud = rotatingCloud();
  let result!: { logsA: string[]; logsB: string[]; refreshes: number };
  await withServer(cloud.handler, async (base) => {
    const { a, b, secrets, stateBlobs } = replicatedWindows(base, deliveryMs);
    stateBlobs.seed("promptworkspace.cloud.session", { mode: "supabase", userId: "u1" });
    await secrets.store("promptworkspace.cloud.access", "stale");
    await secrets.store("promptworkspace.cloud.refresh", "r0");

    const [fromA, fromB] = await Promise.all([
      a.client.listAssignedTasks(),
      b.client.listAssignedTasks(),
    ]);
    // Never a 401, never a sign-out: both windows end on the one valid pair.
    assert.deepEqual(fromA, []);
    assert.deepEqual(fromB, []);
    assert.equal(a.session.read()?.userId, "u1");
    assert.equal(b.session.read()?.userId, "u1");
    assert.equal(await secrets.get("promptworkspace.cloud.refresh"), cloud.current());
    for (const line of [...a.logs, ...b.logs]) assert.doesNotMatch(line, /signing out/);
    result = { logsA: a.logs, logsB: b.logs, refreshes: cloud.refreshes() };
  });
  return result;
}

test("both windows winning the lease still ends in one valid session", async () => {
  // Delivery slower than the read-back: each window reads its own lease back.
  const { logsA, logsB, refreshes } = await bothWindowsRefresh(500);
  assert.equal(refreshes, 2, "both refreshed: the lease could not tell them apart");
  const lostRotation = [...logsA, ...logsB].filter((l) => /lost the rotation/.test(l));
  assert.equal(lostRotation.length, 1, "the loser adopted the winner's pair");
});

test("both windows losing the lease still ends in one valid session", async () => {
  // Delivery faster than the read-back but slower than the gap between the two
  // writes: each window's write is overwritten by the other's in flight.
  const { logsA, logsB } = await bothWindowsRefresh(15);
  assert.ok(logsA.some((l) => /lost the refresh lease/.test(l)), logsA.join("\n"));
  assert.ok(logsB.some((l) => /lost the refresh lease/.test(l)), logsB.join("\n"));
});

test("a lease write cannot revert another window's state", async () => {
  // Window A signs in a new account while window B, holding a stale copy of
  // the state blob, takes the refresh lease. If the lease lived in the state
  // blob, B's write would deliver B's stale copy to A and undo the sign-in.
  const { a, b, stateBlobs } = replicatedWindows("http://unused", 20);
  stateBlobs.seed("promptworkspace.cloud.session", { mode: "supabase", userId: "old" });
  await a.session.store({ mode: "supabase", userId: "new" }, "a1", "r1");
  await b.session.writeRefreshLease({ owner: "b", until: Date.now() + 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(a.session.read()?.userId, "new");
  assert.equal(b.session.read()?.userId, "new");
});

test("a file-backed lease round-trips, and anything unreadable is no lease", async () => {
  const files = new Map<string, string>();
  const store = {
    async read(name: string) {
      return files.get(name);
    },
    async write(name: string, contents: string) {
      files.set(name, contents);
    },
  };
  const leases = fileLeaseStorage(store);
  assert.equal(await leases.read(), undefined);
  await leases.write({ owner: "w1", until: 5 });
  assert.deepEqual(await leases.read(), { owner: "w1", until: 5 });
  await leases.write(undefined);
  assert.equal(await leases.read(), undefined);
  files.set("refresh-lease.json", "{not json");
  assert.equal(await leases.read(), undefined);

  // A store that throws costs the lease, never the session.
  const broken: LeaseStorageLike = {
    read: async () => {
      throw new Error("EBUSY");
    },
    write: async () => {
      throw new Error("EBUSY");
    },
  };
  const session = new SessionStore(memorySecrets(), memoryState(), broken);
  assert.equal(await session.readRefreshLease(), undefined);
  await session.writeRefreshLease({ owner: "w1", until: 5 });
});
