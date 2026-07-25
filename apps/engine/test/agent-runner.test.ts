// WP4 — agent-runner smoke tests (ADR 0009 orchestration of external agent
// CLIs). No env is read at module scope by agent-runner.ts, so a plain
// top-level import is fine here.
//
// Run:  node --test apps/engine/test/agent-runner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyAgentAvailable, runAgentTask } from "../src/agent/agent-runner.ts";
import { AgentError } from "../src/agent/errors.ts";

test("anyAgentAvailable returns a boolean without throwing", () => {
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = anyAgentAvailable();
  });
  assert.equal(typeof result, "boolean");
  // Deliberately no assertion on which agents are installed — not portable
  // across machines/CI.
});

test("runAgentTask rejects with AgentError('no-agent') when no adapter resolves", async (t) => {
  // resolveAdapter() falls back to detectInstalledAgents()[0] for any
  // preferredAgentId it doesn't recognize (apps/engine/src/agent/adapters/index.ts).
  // That only reaches the "no agent CLI available" throw in agent-runner.ts
  // when this machine has zero agent CLIs on PATH. This sandbox may have a
  // real agent CLI (e.g. claude, gemini) installed, in which case the
  // fallback resolves to it instead of throwing, and actually spawning it
  // against a bogus project path is undesirable (slow, side-effecting, not
  // what this test is verifying). Skip conditionally rather than mock
  // detectInstalledAgents (no mocking library in this test suite's convention).
  if (anyAgentAvailable()) {
    t.skip(
      "an agent CLI is installed on this machine, so resolveAdapter() falls back to it " +
        "instead of returning null for an unknown preferredAgentId — the " +
        "'no agent CLI available' throw is only reachable with zero agents on PATH " +
        "(documented gap: this is an environment-dependent test, see WP4 plan)",
    );
    return;
  }

  await assert.rejects(
    () => runAgentTask("/tmp/pz-agent-runner-test-nonexistent", "test task", "prompt", () => {}, "definitely-not-a-real-agent-id"),
    (err: unknown) => {
      assert.ok(err instanceof AgentError, "expected an AgentError");
      assert.equal(err.kind, "no-agent");
      assert.match(err.message, /no agent CLI available/);
      return true;
    },
  );
});

// The "custom" adapter (PROMPTCONNEXT_AGENT_CMD) is also how tests inject a
// fake agent CLI (see adapters/custom.ts) — it lets the "agent-crash" and
// "no-changes" throw sites be exercised deterministically without a real
// agent CLI installed.
async function withTempGitRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pz-agent-runner-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runAgentTask rejects with AgentError('agent-crash') when the agent CLI exits non-zero", async () => {
  const prevCmd = process.env.PROMPTCONNEXT_AGENT_CMD;
  process.env.PROMPTCONNEXT_AGENT_CMD = "exit 1";
  try {
    await withTempGitRepo(async (dir) => {
      await assert.rejects(
        () => runAgentTask(dir, "test task", "prompt", () => {}, "custom"),
        (err: unknown) => {
          assert.ok(err instanceof AgentError, "expected an AgentError");
          assert.equal(err.kind, "agent-crash");
          return true;
        },
      );
    });
  } finally {
    if (prevCmd === undefined) delete process.env.PROMPTCONNEXT_AGENT_CMD;
    else process.env.PROMPTCONNEXT_AGENT_CMD = prevCmd;
  }
});

test("runAgentTask rejects with AgentError('no-changes') when the agent CLI makes no changes", async () => {
  const prevCmd = process.env.PROMPTCONNEXT_AGENT_CMD;
  process.env.PROMPTCONNEXT_AGENT_CMD = "true";
  try {
    await withTempGitRepo(async (dir) => {
      await assert.rejects(
        () => runAgentTask(dir, "test task", "prompt", () => {}, "custom"),
        (err: unknown) => {
          assert.ok(err instanceof AgentError, "expected an AgentError");
          assert.equal(err.kind, "no-changes");
          return true;
        },
      );
    });
  } finally {
    if (prevCmd === undefined) delete process.env.PROMPTCONNEXT_AGENT_CMD;
    else process.env.PROMPTCONNEXT_AGENT_CMD = prevCmd;
  }
});
