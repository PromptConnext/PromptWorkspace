import type { AgentAdapter } from "./types.ts";
import { claudeCode } from "./claude-code.ts";
import { gemini } from "./gemini.ts";
import { codex } from "./codex.ts";
import { custom } from "./custom.ts";

// Registry order = preference when the project's choice is "auto".
export const AGENTS: AgentAdapter[] = [claudeCode, gemini, codex, custom];

export function getAdapter(id: string): AgentAdapter | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function detectInstalledAgents(): AgentAdapter[] {
  return AGENTS.filter((a) => a.detect());
}

// Resolve the adapter for a run: an explicit choice if installed, else the
// first detected agent (registry order), else null → caller uses the fallback.
export function resolveAdapter(preferredId?: string | null): AgentAdapter | null {
  if (preferredId && preferredId !== "auto") {
    const a = getAdapter(preferredId);
    if (a?.detect()) return a;
  }
  return detectInstalledAgents()[0] ?? null;
}

export type { AgentAdapter } from "./types.ts";
