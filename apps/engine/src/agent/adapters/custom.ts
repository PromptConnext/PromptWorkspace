import type { AgentAdapter } from "./types.ts";

// Bring-any-CLI escape hatch: PROMPTCONNEXT_AGENT_CMD is run via `sh -c` with the
// task text in $TASK_PROMPT. Also how tests inject a fake agent. bringsOwnModel
// because the command is fully user-defined.
export const custom: AgentAdapter = {
  id: "custom",
  label: "Custom command",
  bringsOwnModel: true,

  detect() {
    return Boolean(process.env.PROMPTCONNEXT_AGENT_CMD);
  },

  buildSpawn({ prompt }) {
    return {
      command: "sh",
      args: ["-c", process.env.PROMPTCONNEXT_AGENT_CMD ?? "true"],
      env: { TASK_PROMPT: prompt },
    };
  },

  parseLine(line, onDelta) {
    onDelta(line + "\n");
  },
};
