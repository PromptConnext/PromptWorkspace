// Agent-mode implementation (ADR 0006): instead of one-shot codegen, spawn a
// real coding agent headless in the project workspace, pointed at the
// engine's Anthropic-compat façade so it runs on the team's BYO code model.
// Default agent is Claude Code; PROMPTZONE_AGENT_CMD overrides (also used by
// tests to substitute a fake agent).
import { spawn, execFileSync } from "node:child_process";
import { ENGINE_PORT } from "../config.ts";
import { commitAll } from "./loop.ts";

const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveAgentCommand(): string | null {
  const custom = process.env.PROMPTZONE_AGENT_CMD;
  if (custom) return custom;
  try {
    execFileSync("sh", ["-c", "command -v claude"], { stdio: "pipe" });
    return "claude";
  } catch {
    return null;
  }
}

type StreamJsonLine = {
  type?: string;
  result?: string;
  message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] };
};

function describeLine(line: string, onDelta: (text: string) => void): void {
  let parsed: StreamJsonLine;
  try {
    parsed = JSON.parse(line);
  } catch {
    onDelta(line + "\n");
    return;
  }
  if (parsed.type === "assistant") {
    for (const block of parsed.message?.content ?? []) {
      if (block.type === "text" && block.text) onDelta(block.text);
      else if (block.type === "tool_use") {
        const hint =
          block.input && typeof block.input === "object"
            ? String(
                (block.input as { file_path?: string; command?: string }).file_path ??
                  (block.input as { command?: string }).command ??
                  "",
              ).slice(0, 120)
            : "";
        onDelta(`\n[${block.name}] ${hint}\n`);
      }
    }
  } else if (parsed.type === "result" && parsed.result) {
    onDelta(`\n${parsed.result}\n`);
  }
}

function changedFiles(projectPath: string): string[] {
  return execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: projectPath })
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").pop()!.trim())
    .filter(Boolean);
}

export async function runAgentTask(
  projectPath: string,
  taskLabel: string,
  prompt: string,
  onDelta: (text: string) => void,
): Promise<{ files: string[]; commitSha: string; agent: string }> {
  const cmd = resolveAgentCommand();
  if (!cmd) throw new Error("no agent CLI available");

  const isClaude = cmd === "claude";
  // Safe default: file tools only. The BYO model steers the agent, and an
  // untrusted/compromised model endpoint must not get shell access. Setting
  // PROMPTZONE_AGENT_ALLOW_BASH=1 opts in (lets the agent run tests) — the
  // user accepts that their connected code model can execute commands.
  const allowedTools =
    process.env.PROMPTZONE_AGENT_ALLOW_BASH === "1"
      ? "Edit,Write,Read,Glob,Grep,Bash"
      : "Edit,Write,Read,Glob,Grep";
  const child = isClaude
    ? spawn(
        "claude",
        [
          "-p", prompt,
          "--output-format", "stream-json",
          "--verbose",
          "--permission-mode", "acceptEdits",
          "--allowedTools", allowedTools,
        ],
        {
          cwd: projectPath,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${ENGINE_PORT}/anthropic`,
            ANTHROPIC_API_KEY: "promptzone-local-proxy",
            NO_COLOR: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    : spawn("sh", ["-c", cmd], {
        cwd: projectPath,
        env: { ...process.env, TASK_PROMPT: prompt },
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
      if (!line.trim()) continue;
      if (isClaude) describeLine(line, onDelta);
      else onDelta(line + "\n");
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
    throw new Error(`agent exited with code ${exitCode}: ${stderr.slice(-400)}`);
  }
  const files = changedFiles(projectPath);
  if (files.length === 0) {
    throw new Error("agent completed but made no changes to the repository");
  }
  const commitSha = commitAll(projectPath, `promptzone: ${taskLabel}`);
  return { files, commitSha, agent: isClaude ? "claude-code" : "custom" };
}
