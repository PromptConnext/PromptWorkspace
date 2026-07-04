import { execFileSync } from "node:child_process";
import type { AgentAdapter } from "./types.ts";

// Claude Code — routed to the connected BYO model through the engine's
// Anthropic façade (bringsOwnModel: false). Safe default is file tools only;
// PROMPTZONE_AGENT_ALLOW_BASH=1 adds shell (see ADR 0006/0008).
type StreamJsonLine = {
  type?: string;
  result?: string;
  message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] };
};

export const claudeCode: AgentAdapter = {
  id: "claude-code",
  label: "Claude Code",
  bringsOwnModel: false,

  detect() {
    try {
      execFileSync("sh", ["-c", "command -v claude"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  },

  buildSpawn({ prompt, engineBaseUrl, configDir, allowBash }) {
    const allowedTools = allowBash
      ? "Edit,Write,Read,Glob,Grep,Bash"
      : "Edit,Write,Read,Glob,Grep";
    return {
      command: "claude",
      args: [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", allowedTools,
      ],
      env: {
        ANTHROPIC_BASE_URL: `${engineBaseUrl}/anthropic`,
        ANTHROPIC_API_KEY: "promptzone-local-proxy",
        // Isolate from the user's personal Claude Code setup: no global
        // plugins/hooks leaking tools or state files into the workspace.
        CLAUDE_CONFIG_DIR: configDir,
        NO_COLOR: "1",
      },
    };
  },

  parseLine(line, onDelta) {
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
  },
};
