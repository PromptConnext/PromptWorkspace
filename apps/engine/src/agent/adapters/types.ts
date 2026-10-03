// Pluggable coding-agent adapters (ADR 0009). PromptWorkspace orchestrates external
// agent CLIs instead of shipping its own coding-agent runtime. Each adapter
// knows how to detect its CLI, launch it headless in the project workspace,
// and turn its output into a readable stream. Result capture (changed files →
// commit → task-done) is agent-agnostic and lives in the runner, so adapters
// stay thin.
export type SpawnPlan = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type BuildSpawnOptions = {
  prompt: string;
  engineBaseUrl: string; // http://127.0.0.1:<port> — for agents routed to our BYO model
  configDir: string; // isolated agent config dir
  allowBash: boolean; // let the agent run shell (tests) — opt-in
};

export type AgentAdapter = {
  id: string;
  label: string;
  // true  → the agent uses its own account/model (dev's Codex/Gemini auth)
  // false → PromptWorkspace routes it to the connected BYO model via the façade
  bringsOwnModel: boolean;
  detect(): boolean;
  buildSpawn(opts: BuildSpawnOptions): SpawnPlan;
  // Translate one stdout line into human-readable progress (onDelta). Defensive:
  // anything unrecognized should still surface as raw text.
  parseLine(line: string, onDelta: (text: string) => void): void;
};
