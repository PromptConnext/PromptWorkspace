import { Hono } from "hono";
import { db, getAppState } from "../db.ts";
import { healthCheck, type ModelConnection } from "../gateway/index.ts";

export const onboarding = new Hono();

// The BYOM cold-start gate (architecture §3.4): `satisfied` requires at least
// one live, health-checked connection — a stored-but-dead key never counts.
function currentState(): "not_started" | "in_progress" | "satisfied" {
  const verified = db
    .prepare("SELECT COUNT(*) AS n FROM model_connections WHERE verified_at IS NOT NULL")
    .get() as { n: number };
  if (verified.n > 0) return "satisfied";
  return (getAppState("model_onboarding_state") as "not_started" | "in_progress" | null) ??
    "not_started";
}

onboarding.get("/engine/onboarding/state", (c) => c.json({ state: currentState() }));

onboarding.post("/engine/onboarding/verify", async (c) => {
  const { connectionId } = await c.req.json<{ connectionId?: string }>();
  const conn = db
    .prepare(
      "SELECT id, role, mode, provider, endpoint, model, credential_ref, verified_at FROM model_connections WHERE id = ?",
    )
    .get(connectionId ?? "") as ModelConnection | undefined;
  if (!conn) return c.json({ error: "connection not found" }, 404);

  try {
    await healthCheck(conn);
    db.prepare("UPDATE model_connections SET verified_at = datetime('now') WHERE id = ?").run(conn.id);
    return c.json({ healthy: true });
  } catch (err) {
    db.prepare("UPDATE model_connections SET verified_at = NULL WHERE id = ?").run(conn.id);
    return c.json({ healthy: false, error: (err as Error).message }, 422);
  }
});

// Static recommendations for now — the "recommended profiles" guardrail
// (roadmap risk #4). The zero-cost path is listed first on purpose.
onboarding.get("/engine/onboarding/recommendations", (c) =>
  c.json({
    recommendations: [
      {
        provider: "ollama",
        label: "Local Ollama (no cost, no signup)",
        endpoint: "http://127.0.0.1:11434",
        model: "qwen3:8b",
        needsKey: false,
        role: "plan",
      },
      {
        provider: "openrouter",
        label: "OpenRouter (one key, many models)",
        endpoint: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-sonnet-4.5",
        needsKey: true,
        role: "plan",
      },
      {
        // Strong tool-calling coding model — a good code-role pick where a
        // small local model can't drive the agent loop (ADR 0006 finding).
        provider: "zai",
        label: "Z.AI GLM (strong coding, tool-calling)",
        endpoint: "https://api.z.ai/api/paas/v4",
        model: "glm-4.6",
        needsKey: true,
        role: "code",
      },
      {
        provider: "openai",
        label: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5",
        needsKey: true,
        role: "plan",
      },
    ],
  }),
);
