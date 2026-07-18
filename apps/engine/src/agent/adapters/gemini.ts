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
      args: [
        "-p", prompt,
        "--approval-mode", allowBash ? "yolo" : "auto_edit",
        // Structured events → incremental progress in the UI. Default text
        // output only prints a summary at the very end (verified live: the run
        // appeared to hang with nothing streamed).
        "--output-format", "stream-json",
      ],
      env: {
        NO_COLOR: "1",
        // Headless Gemini refuses to act in an "untrusted" folder (exit 55) and
        // silently downgrades --approval-mode to "default". PromptConnext owns the
        // project directory, so trusting it is correct. (Verified live: without
        // this, no file is written; with it, edits apply.)
        GEMINI_CLI_TRUST_WORKSPACE: "true",
      },
    };
  },

  // Gemini stream-json events: init | message | tool_use | tool_result | result.
  parseLine(line, onDelta) {
    let ev: {
      type?: string;
      role?: string;
      content?: unknown;
      tool_name?: string;
      result?: string;
    };
    try {
      ev = JSON.parse(line);
    } catch {
      onDelta(line + "\n");
      return;
    }
    if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
      onDelta(ev.content);
    } else if (ev.type === "tool_use" && ev.tool_name) {
      onDelta(`\n[${ev.tool_name}]\n`);
    } else if (ev.type === "result" && typeof ev.result === "string") {
      onDelta(`\n${ev.result}\n`);
    }
    // init / tool_result / user messages → no user-facing output
  },
};
