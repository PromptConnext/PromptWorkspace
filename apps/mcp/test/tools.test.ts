// Run:  node --test apps/mcp/test/tools.test.ts
//
// Same strategy as packages/pz-cloud's suite and apps/engine's: no mocking
// library, a real http.createServer on port 0 standing in for the cloud, and the
// code under test genuinely making requests. The two tools are driven through
// the SDK's own in-memory transport rather than called directly, so what is
// asserted is what a client would actually receive.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CloudClient,
  SessionStore,
  type AssignedTask,
  type LoggerLike,
  type SecretsLike,
  type StorageLike,
} from "@promptconnext/pz-cloud";
import { readConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";

const silent: LoggerLike = { info: () => {}, warn: () => {}, error: () => {} };

function memorySecrets(): SecretsLike {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async store(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function memoryState(): StorageLike {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async update(key, value) {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

const TASK: AssignedTask = {
  task: {
    id: "task-1",
    project_id: "proj-1",
    spec_id: "spec-1",
    title: "Add a retry to the uploader",
    status: "in_progress",
    feature_tag: "T012",
    acceptance_criteria: [{ text: "Retries three times" }, { text: "Backs off" }],
  },
  project_id: "proj-1",
  project_name: "Uploader",
  workspace_id: "ws-1",
  workspace_name: "Acme",
  repo_url: "https://github.com/acme/uploader",
};

interface Recorded {
  path: string;
}

interface Harness {
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  listToolNames: () => Promise<string[]>;
  seen: Recorded[];
}

async function withTools(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const seen: Recorded[] = [];
  const http: HttpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    seen.push({ path });
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/me/tasks")) {
      res.end(JSON.stringify([TASK]));
    } else if (path.startsWith("/sync/projects/proj-1/graph")) {
      res.end(
        JSON.stringify({
          tasks: [],
          spec_documents: [
            { id: "spec-1", project_id: "proj-1", requirement_id: "r1", content: "Upload spec body.", version: 1 },
          ],
        }),
      );
    } else if (path.startsWith("/projects/proj-1/stage-documents/constitution")) {
      res.end(JSON.stringify({ id: "c1", stage: "constitution", content: "Prefer small diffs.", updated_at: null }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const session = new SessionStore(memorySecrets(), memoryState());
  await session.store({ mode: "stub", userId: "dev-user" });
  const client = new CloudClient({
    session,
    config: () => ({
      apiUrl: `http://127.0.0.1:${port}`,
      supabaseUrl: "",
      supabaseAnonKey: "",
    }),
    fetch: (input, init) => fetch(input, init),
    log: silent,
  });

  const server = createServer(client, silent);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  try {
    await fn({
      call: async (name, args) =>
        (await mcp.callTool({ name, arguments: args })) as CallToolResult,
      listToolNames: async () => (await mcp.listTools()).tools.map((t) => t.name),
      seen,
    });
  } finally {
    await mcp.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

test("the server advertises exactly the two read-only tools of this milestone", async () => {
  await withTools(async ({ listToolNames }) => {
    // A third name appearing here means a later milestone's tool
    // (get_project_rules, close_task) landed early, or a claim tool was
    // invented for which /me/tasks gives no caller. Plan 0025 §1 and §5.
    assert.deepEqual(await listToolNames(), ["list_my_tasks", "get_task"]);
  });
});

test("list_my_tasks names the id an assistant needs for get_task", async () => {
  await withTools(async ({ call }) => {
    const result = await call("list_my_tasks", {});
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /T012: Add a retry to the uploader/);
    assert.match(body, /id: task-1/);
    assert.match(body, /project: Uploader \(Acme\)/);
  });
});

test("list_my_tasks passes its filters through as query parameters", async () => {
  await withTools(async ({ call, seen }) => {
    await call("list_my_tasks", { workspace_id: "ws-1", status: ["todo", "verified"] });
    const request = seen.find((s) => s.path.startsWith("/me/tasks"));
    assert.ok(request);
    assert.match(request.path, /workspace_id=ws-1/);
    assert.match(request.path, /status=todo/);
    assert.match(request.path, /status=verified/);
  });
});

test("an unknown status is refused rather than silently dropped", async () => {
  await withTools(async ({ call }) => {
    const result = await call("list_my_tasks", { status: ["done"] });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /must be one of/);
  });
});

test("get_task assembles criteria, spec excerpt and repository", async () => {
  await withTools(async ({ call }) => {
    const result = await call("get_task", { task_id: "task-1" });
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /# Task T012: Add a retry to the uploader/);
    assert.match(body, /- \[ \] Retries three times/);
    assert.match(body, /## Specification/);
    assert.match(body, /Upload spec body\./);
    assert.match(body, /- Repository: https:\/\/github\.com\/acme\/uploader/);
    assert.match(body, /## Project coding rules/);
    assert.match(body, /Prefer small diffs\./);
  });
});

test("get_task asks for every status, so an implemented task is still readable", async () => {
  await withTools(async ({ call, seen }) => {
    await call("get_task", { task_id: "task-1" });
    const request = seen.find((s) => s.path.startsWith("/me/tasks"));
    assert.ok(request);
    for (const status of ["todo", "in_progress", "implemented", "verified"]) {
      assert.match(request.path, new RegExp(`status=${status}`));
    }
  });
});

test("a task that is not assigned to the caller is a tool error, not a throw", async () => {
  await withTools(async ({ call }) => {
    const result = await call("get_task", { task_id: "nope" });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /No task nope is assigned to you/);
  });
});

test("config precedence is default, then file, then environment", () => {
  const withEnv = readConfig({
    PROMPTCONNEXT_MCP_CONFIG_DIR: "/nonexistent-promptconnext-mcp",
    PROMPTCONNEXT_CLOUD_API_URL: "http://localhost:8080/",
  } as NodeJS.ProcessEnv);
  // Env wins, and a trailing slash is trimmed the way apps/vscode trims it.
  assert.equal(withEnv.cloudApiUrl, "http://localhost:8080");
  // Anything unset falls back to the same default apps/vscode ships.
  assert.equal(withEnv.cloudWebUrl, "https://prompt-zone-web-app.vercel.app");
  assert.equal(withEnv.supabaseUrl, "");
  assert.equal(withEnv.supabaseAnonKey, "");
});
