import { execFileSync } from "node:child_process";
import type { AgentAdapter } from "./types.ts";

// Gemini CLI — uses the developer's own Google/Gemini auth and model
// (bringsOwnModel: true). Headless via -p; --approval-mode auto_edit
// auto-approves edit tools only (shell stays gated), mirroring our file-first
// default. yolo when Bash is opted in.
export const gemini: AgentAdapter = {
  id: "gemini",
  label: "Gemini CLI",
  bringsOwnModel: true,

  detect() {
    try {
      execFileSync("sh", ["-c", "command -v gemini"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  },

  buildSpawn({ prompt, allowBash }) {
    return {
      command: "gemini",
      args: ["-p", prompt, "--approval-mode", allowBash ? "yolo" : "auto_edit"],
      env: { NO_COLOR: "1" },
    };
  },

  // Default text output — stream lines as-is.
  parseLine(line, onDelta) {
    onDelta(line + "\n");
  },
};
