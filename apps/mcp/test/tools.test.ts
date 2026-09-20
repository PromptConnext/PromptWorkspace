// Run:  node --test apps/mcp/test/tools.test.ts
//
// Same strategy as packages/pz-cloud's suite and apps/engine's: no mocking
// library, a real http.createServer on port 0 standing in for the cloud, and the
// code under test genuinely making requests. The tools are driven through the
// SDK's own in-memory transport rather than called directly, so what is asserted
// is what a client would actually receive.
//
// `get_project_rules` extends that to the disk: the clones below are real git
// repositories in a temp directory with real remotes, because the thing most
// likely to be wrong is the remote parsing and the URL matching, and a stubbed
// `git remote -v` would test neither.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const REPO_URL = "https://github.com/acme/uploader";

const PROJECT = {
  id: "proj-1",
  name: "Uploader",
  workspace_id: "ws-1",
  repo_url: REPO_URL,
  repo_default_branch: "main",
  lifecycle_status: "repo_created",
};

interface Recorded {
  path: string;
}

interface Harness {
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  listToolNames: () => Promise<string[]>;
  seen: Recorded[];
}

interface HarnessOptions {
  /** Extra projects in the same workspace — a fork or a monorepo sharing a
   *  remote with `PROJECT`. */
  extraProjects?: unknown[];
}

async function withTools(
  fn: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const seen: Recorded[] = [];
  const http: HttpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    seen.push({ path });
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/me/tasks")) {
      res.end(JSON.stringify([TASK]));
    } else if (path.startsWith("/workspaces/ws-1/projects")) {
      res.end(JSON.stringify([PROJECT, ...(options.extraProjects ?? [])]));
    } else if (path.startsWith("/workspaces")) {
      res.end(JSON.stringify([{ id: "ws-1", name: "Acme" }]));
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

/** A real git repository, with the seeded files the test asks for. */
function makeClone(files: Record<string, string>, remote: string | null = REPO_URL): string {
  const root = mkdtempSync(join(tmpdir(), "pz-mcp-clone-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root, stdio: "pipe" });
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  clones.push(root);
  return root;
}

const clones: string[] = [];

after(() => {
  for (const root of clones) rmSync(root, { recursive: true, force: true });
});

test("the server advertises exactly the read-only tools of this milestone", async () => {
  await withTools(async ({ listToolNames }) => {
    // A fourth name appearing here means M3's close_task landed early, or a
    // claim tool was invented for which /me/tasks gives no caller. Plan 0025
    // §1 and §5.
    assert.deepEqual(await listToolNames(), [
      "list_my_tasks",
      "get_task",
      "get_project_rules",
    ]);
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

test("get_project_rules resolves the project from the clone's git remote", async () => {
  // An SSH shorthand against the cloud's https repo_url, which is the shape a
  // real developer's remote actually has — string equality would miss it.
  const root = makeClone(
    {
      "AGENTS.md": "Always write a test.",
      "docs/conventions.md": "Prose-forward docs.",
      ".specify/memory/constitution.md": "Prefer small diffs.",
    },
    "git@github.com:acme/uploader.git",
  );
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root });
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /# Coding rules for Uploader \(Acme\)/);
    assert.match(body, /- Project id: proj-1/);
    assert.match(body, new RegExp(`- Workspace root: ${root}`));
    assert.match(body, /## AGENTS\.md \(`AGENTS\.md`\)/);
    assert.match(body, /Always write a test\./);
    assert.match(body, /## Conventions \(`docs\/conventions\.md`\)/);
    assert.match(body, /Prose-forward docs\./);
    assert.match(body, /## Constitution \(`\.specify\/memory\/constitution\.md`\)/);
  });
});

test("a seeded file that is missing is stated as missing, not omitted", async () => {
  const root = makeClone({ "AGENTS.md": "Always write a test." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    // The heading is present for all three regardless — "this project has no
    // conventions doc" is an answer, and silence is one an agent fills in by
    // guessing.
    assert.match(body, /## Conventions \(`docs\/conventions\.md`\)\n\n_Not present in this clone\._/);
    assert.match(body, /Always write a test\./);
  });
});

test("a constitution matching the cloud's stage document is reported as unchanged", async () => {
  // Reflowed, not rewritten: the comparison is whitespace-normalised, because
  // reporting a reflow as drift trains the developer to ignore the notice.
  const root = makeClone({ ".specify/memory/constitution.md": "Prefer   small\n  diffs." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    assert.match(body, /unchanged from the cloud's constitution stage document/);
  });
});

test("a constitution that has moved on from the cloud's is flagged as diverged", async () => {
  const root = makeClone({ ".specify/memory/constitution.md": "Ship large rewrites." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    assert.match(body, /diverged from the cloud's constitution stage document/);
    // The file is the authority, so it — not the cloud copy — is what is shown.
    assert.match(body, /Ship large rewrites\./);
    assert.doesNotMatch(body, /Prefer small diffs\./);
  });
});

test("a constitution absent from the clone falls back to the cloud, and says so", async () => {
  const root = makeClone({ "AGENTS.md": "Always write a test." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    assert.match(body, /shown from the cloud's constitution stage document/);
    assert.match(body, /Prefer small diffs\./);
  });
});

test("a folder whose remote matches no project is a tool error naming the remote", async () => {
  const root = makeClone({ "AGENTS.md": "x" }, "https://github.com/someone/unrelated.git");
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root });
    assert.equal(result.isError, true);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /No PromptConnext project's repository matches the git remote/);
    assert.match(body, /someone\/unrelated/);
  });
});

test("project_id overrides remote matching, so an unrelated folder still answers", async () => {
  const root = makeClone({ "AGENTS.md": "Always write a test." }, "https://github.com/someone/unrelated.git");
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root, project_id: "proj-1" });
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /# Coding rules for Uploader \(Acme\)/);
    assert.match(body, /Always write a test\./);
  });
});

test("an unknown project_id is refused rather than silently falling back to the remote", async () => {
  const root = makeClone({ "AGENTS.md": "x" });
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root, project_id: "proj-9" });
    assert.equal(result.isError, true);
    assert.match(
      (result.content[0] as { text: string }).text,
      /No PromptConnext project proj-9 is visible to you/,
    );
  });
});

test("two projects sharing one remote ask the developer to disambiguate", async () => {
  const root = makeClone({ "AGENTS.md": "x" });
  await withTools(
    async ({ call }) => {
      const result = await call("get_project_rules", { workspace_root: root });
      assert.equal(result.isError, true);
      const body = (result.content[0] as { text: string }).text;
      // Guessing between them would hand the agent another project's rules and
      // look like it worked.
      assert.match(body, /2 PromptConnext projects share the git remote/);
      assert.match(body, /proj-1: Uploader/);
      assert.match(body, /proj-2: Uploader fork/);
    },
    {
      extraProjects: [
        {
          id: "proj-2",
          name: "Uploader fork",
          workspace_id: "ws-1",
          repo_url: `${REPO_URL}.git`,
          lifecycle_status: "repo_created",
        },
      ],
    },
  );
});

test("a folder that is not a git repository says so rather than reporting no match", async () => {
  const root = mkdtempSync(join(tmpdir(), "pz-mcp-plain-"));
  clones.push(root);
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root });
    assert.equal(result.isError, true);
    assert.match(
      (result.content[0] as { text: string }).text,
      /is not inside a git repository/,
    );
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
