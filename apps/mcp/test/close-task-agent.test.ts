// Run:  node --test apps/mcp/test/close-task-agent.test.ts
//
// Plan 0033 §governance: a task closed through this server says which MCP client
// closed it, as `artifact.agent.client`. The name is the one the client sent in
// its `initialize` handshake (`clientInfo.name`), prefixed `mcp:`; a client that
// sends none is recorded as plain `mcp` rather than as nobody.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CloudClient,
  SessionStore,
  type LoggerLike,
  type SecretsLike,
  type StorageLike,
} from "@promptworkspace/cloud-client";
import { createStatusQueue } from "../src/cloud.ts";
import { createServer } from "../src/server.ts";
import { StatusWriter } from "../src/statusWriter.ts";

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

const TASK = {
  id: "task-1",
  project_id: "proj-1",
  spec_id: "spec-1",
  title: "Add a retry to the uploader",
  status: "in_progress",
  feature_tag: "T012",
  acceptance_criteria: [{ text: "Retries three times" }],
};
const ASSIGNED = {
  task: TASK,
  project_id: "proj-1",
  project_name: "Uploader",
  workspace_id: "ws-1",
  workspace_name: "Acme",
  repo_url: "https://github.com/acme/uploader",
};

/** Initialise a client with `clientInfo`, close a task, and hand back the
 *  artifact the fake cloud received. */
async function artifactFor(clientInfo: { name: string; version: string }): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const http = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PATCH") {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end(JSON.stringify({ ...TASK, status: "implemented" }));
      } else if ((req.url ?? "").startsWith("/me/tasks")) {
        res.end(JSON.stringify([ASSIGNED]));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: "not found" }));
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const queueDir = mkdtempSync(join(tmpdir(), "pz-mcp-agent-"));

  const session = new SessionStore(memorySecrets(), memoryState());
  await session.store({ mode: "stub", userId: "dev-user" });
  const client = new CloudClient({
    session,
    config: () => ({ apiUrl: `http://127.0.0.1:${port}`, supabaseUrl: "", supabaseAnonKey: "" }),
    fetch: (input, init) => fetch(input, init),
    log: silent,
  });
  const writer = new StatusWriter(client, createStatusQueue(queueDir), silent);
  const server = createServer(client, silent, writer);
  const mcp = new Client(clientInfo);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const result = await mcp.callTool({
      name: "close_task",
      arguments: {
        task_id: "task-1",
        status: "implemented",
        commit_sha: "1a2b3c4d5e6f",
        commit_message: "T012: retry the upload",
      },
    });
    assert.notEqual((result as { isError?: boolean }).isError, true);
    assert.equal(bodies.length, 1);
    return bodies[0].artifact as Record<string, unknown>;
  } finally {
    await mcp.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(queueDir, { recursive: true, force: true });
  }
}

test("close_task names the MCP client that initialised the session", async () => {
  const artifact = await artifactFor({ name: "cursor", version: "1" });
  assert.deepEqual(artifact.agent, { client: "mcp:cursor" });
  assert.equal(artifact.commit_sha, "1a2b3c4d5e6f");
});

test("close_task falls back to plain `mcp` when the client sent no name", async () => {
  const artifact = await artifactFor({ name: "", version: "1" });
  assert.deepEqual(artifact.agent, { client: "mcp" });
});
