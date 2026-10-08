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
import { SessionStore, type SecretsLike, type StorageLike } from "../src/session.ts";

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
