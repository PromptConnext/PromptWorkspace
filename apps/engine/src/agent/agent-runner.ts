// Orchestrates an external coding-agent CLI (ADR 0009). PromptConnext does not
// ship its own coding-agent runtime; it launches whichever agent the developer
// prefers (Claude Code / Gemini / Codex / custom) headless in the project
// workspace and captures the result from Git — a capture path that is
// agent-agnostic, so adapters stay thin.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_PORT } from "../config.ts";
import { dataDir } from "../db.ts";
import { commitFiles } from "./loop.ts";
import { resolveAdapter, detectInstalledAgents } from "./adapters/index.ts";
import { AgentError } from "./errors.ts";

const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

function agentConfigDir(): string {
  const dir = join(dataDir(), "agent-config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// True when at least one agent CLI (or a custom command) is available.
export function anyAgentAvailable(): boolean {
  return detectInstalledAgents().length > 0;
}

function changedFiles(projectPath: string): string[] {
  return execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: projectPath })
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").pop()!.trim())
    // Tooling state (.omc/, .claude/, …) is not implementation output — a
    // plugin writing its session files must not count as "the agent did work".
    .filter((path) => path && !path.split("/")[0].startsWith("."));
}

export async function runAgentTask(
  projectPath: string,
  taskLabel: string,
  prompt: string,
  onDelta: (text: string) => void,
  preferredAgentId?: string | null,
): Promise<{ files: string[]; commitSha: string; agent: string }> {
  const adapter = resolveAdapter(preferredAgentId);
  if (!adapter) throw new AgentError("no-agent", "no agent CLI available");

  const plan = adapter.buildSpawn({
    prompt,
    engineBaseUrl: `http://127.0.0.1:${ENGINE_PORT}`,
    configDir: agentConfigDir(),
    allowBash: process.env.PROMPTCONNEXT_AGENT_ALLOW_BASH === "1",
  });

  const child = spawn(plan.command, plan.args, {
    cwd: projectPath,
    env: { ...process.env, ...(plan.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) adapter.parseLine(line, onDelta);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent timed out after ${AGENT_TIMEOUT_MS / 60000} minutes`));
    }, AGENT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new AgentError(
      "agent-crash",
      `${adapter.label} exited with code ${exitCode}: ${stderr.slice(-400)}`,
    );
  }
  const files = changedFiles(projectPath);
  if (files.length === 0) {
    throw new AgentError(
      "no-changes",
      `${adapter.label} completed but made no changes to the repository`,
    );
  }
  const commitSha = commitFiles(projectPath, files, `promptconnext: ${taskLabel}`);
  return { files, commitSha, agent: adapter.id };
}
