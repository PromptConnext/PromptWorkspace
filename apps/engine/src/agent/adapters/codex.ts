import { execFileSync } from "node:child_process";
import type { AgentAdapter } from "./types.ts";

// OpenAI Codex CLI — the developer's own OpenAI auth/model (bringsOwnModel:
// true). Headless via `codex exec`; --full-auto grants workspace-write with
// auto-approval (no network by default). EXPERIMENTAL: not verified against a
// live install here — confirm flags before relying on it.
export const codex: AgentAdapter = {
  id: "codex",
  label: "Codex CLI (experimental)",
  bringsOwnModel: true,

  detect() {
    try {
      execFileSync("sh", ["-c", "command -v codex"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  },

  buildSpawn({ prompt }) {
    return {
      command: "codex",
      args: ["exec", "--full-auto", prompt],
      env: { NO_COLOR: "1" },
    };
  },

  parseLine(line, onDelta) {
    onDelta(line + "\n");
  },
};
