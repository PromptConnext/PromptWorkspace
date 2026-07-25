// Agent discovery & per-project selection (ADR 0009). Lists the coding-agent
// CLIs available on this machine and lets a project pin which one runs
// implementation. Result capture is agent-agnostic (Git), so this is all the
// integration most agents need.
import { Hono } from "hono";
import { AGENTS } from "../agent/adapters/index.ts";
import { getAppState, setAppState } from "../db.ts";

export const agents = new Hono();

// Per-adapter-id install docs, surfaced for CLIs the user hasn't installed yet
// so the "not installed" chip can link somewhere useful (WP6).
const INSTALL_URLS: Record<string, string> = {
  "claude-code": "https://docs.claude.com/en/docs/claude-code/overview",
  gemini: "https://github.com/google-gemini/gemini-cli",
  codex: "https://github.com/openai/codex",
};

agents.get("/engine/agents", (c) => {
  const list = AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    installed: a.detect(),
    bringsOwnModel: a.bringsOwnModel,
    installUrl: INSTALL_URLS[a.id],
  }));
  return c.json({ agents: list });
});

agents.get("/engine/projects/:id/agent", (c) => {
  const selected = getAppState(`implementation_agent.${c.req.param("id")}`) ?? "auto";
  return c.json({ selected });
});

agents.post("/engine/projects/:id/agent", async (c) => {
  const { agentId } = await c.req.json<{ agentId?: string }>();
  const valid = agentId === "auto" || AGENTS.some((a) => a.id === agentId);
  if (!agentId || !valid) return c.json({ error: "unknown agent id" }, 400);
  setAppState(`implementation_agent.${c.req.param("id")}`, agentId);
  return c.json({ selected: agentId });
});
