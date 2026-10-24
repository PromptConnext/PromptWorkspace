// Run:  node --test apps/vscode/test/unit/statusWriter.test.ts
//
// statusWriter.ts imports the `vscode` module, which only exists inside the
// editor host. A resolve/load hook below stands in for it (only the warning
// toast is ever touched) so the real class runs under plain `node --test`.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") return { url: "node:vscode-stub", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "node:vscode-stub") {
      return {
        format: "module",
        source: "export const window = { showWarningMessage() {} };",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

// Imported lazily: the hooks above must be in place before the module loads.
const loadWriter = async () => (await import("../../src/tasks/statusWriter.ts")).StatusWriter;

type Patch = { projectId: string; taskId: string; update: Record<string, unknown> };

async function writerFor(appName: string) {
  const patches: Patch[] = [];
  const client = {
    async patchTaskStatus(projectId: string, taskId: string, update: Record<string, unknown>) {
      patches.push({ projectId, taskId, update });
    },
    signedIn: () => true,
  };
  const store = {
    applyLocalStatus: () => undefined,
    async refresh() {},
  };
  const log = { info() {}, warn() {}, error() {} };
  const StatusWriter = await loadWriter();
  const writer = new StatusWriter(
    client as never,
    store as never,
    {} as never,
    log as never,
    () => {},
    () => ({ scope: "s" }),
    appName,
  );
  return { writer, patches };
}

test("a close names the editor it came from", async () => {
  const { writer, patches } = await writerFor("Cursor");
  await writer.setStatus({
    projectId: "p1",
    taskId: "t1",
    status: "implemented",
    artifact: { commit_sha: "abc123", uri: "git: T1", kind: "code" },
  });
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].update.artifact, {
    commit_sha: "abc123",
    uri: "git: T1",
    kind: "code",
    agent: { client: "vscode:Cursor" },
  });
});

test("a write with no artifact stays without one", async () => {
  const { writer, patches } = await writerFor("Visual Studio Code");
  await writer.setStatus({ projectId: "p1", taskId: "t1", status: "in_progress" });
  assert.equal(patches[0].update.artifact, undefined);
});

test("an over-long app name is cut to the cloud's 64-character limit", async () => {
  const { writer, patches } = await writerFor("x".repeat(100));
  await writer.setStatus({
    projectId: "p1",
    taskId: "t1",
    status: "implemented",
    artifact: { commit_sha: "abc123", uri: "git: T1", kind: "code" },
  });
  const agent = (patches[0].update.artifact as { agent: { client: string } }).agent;
  assert.equal(agent.client.length, 64);
  assert.ok(agent.client.startsWith("vscode:xxx"));
});
