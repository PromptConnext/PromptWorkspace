import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { db, setAppState } from "../db.ts";
import { storeSecret, deleteSecret } from "../keychain.ts";
import { chat, healthCheck, type ModelConnection } from "../gateway/index.ts";

export const models = new Hono();

function listConnections(): ModelConnection[] {
  return db
    .prepare(
      "SELECT id, role, mode, provider, endpoint, model, credential_ref, verified_at FROM model_connections ORDER BY created_at",
    )
    .all() as ModelConnection[];
}

export function connectionForRole(role: string): ModelConnection | undefined {
  // Newest verified connection wins: reconnecting a role supersedes the prior
  // one (see connect handler), so resolve most-recent-first rather than by
  // insertion order. Degrade within what's connected (architecture §3.3):
  // exact role first, then any verified connection.
  const verified = listConnections()
    .filter((c) => c.verified_at)
    .reverse();
  return verified.find((c) => c.role === role) ?? verified[0];
}

// No fallback: implementation must not silently run on the planning model —
// the just-in-time Skill prompt exists to get a real coding model connected.
export function connectionForRoleStrict(role: string): ModelConnection | undefined {
  return listConnections()
    .filter((c) => c.verified_at)
    .reverse()
    .find((c) => c.role === role);
}

export { chat };

// Env to point a terminal-launched Claude Code / Codex at the connected
// code-role model via our Anthropic façade (ADR 0006). Mirrors the manual
// setup in the local-LLM guides, but with our translation layer so Ollama's
// tool calls work. Attribution header off protects local-model KV cache.
models.get("/engine/local-llm-env", (c) => {
  const conn = connectionForRole("code") ?? connectionForRole("plan");
  if (!conn) return c.json({ error: "no verified model connected" }, 409);
  const base = new URL(c.req.url);
  return c.json({
    model: `${conn.provider}/${conn.model}`,
    env: {
      ANTHROPIC_BASE_URL: `${base.protocol}//${base.host}/anthropic`,
      ANTHROPIC_AUTH_TOKEN: "promptconnext-local",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    },
  });
});

models.get("/engine/models", (c) => {
  const conns = listConnections().map((conn) => ({
    ...conn,
    credential_ref: undefined,
    has_credential: Boolean(conn.credential_ref),
    healthy: Boolean(conn.verified_at),
  }));
  return c.json({ connections: conns });
});

models.post("/engine/models/connect", async (c) => {
  const body = await c.req.json<{
    role?: string;
    provider?: string;
    endpoint?: string;
    model?: string;
    apiKey?: string;
  }>();

  const role = body.role ?? "plan";
  if (!["plan", "code", "thai", "other"].includes(role)) {
    return c.json({ error: `unknown role: ${role}` }, 400);
  }
  if (!body.provider || !body.endpoint || !body.model) {
    return c.json({ error: "provider, endpoint and model are required" }, 400);
  }

  const id = randomUUID();
  let credentialRef: string | null = null;
  if (body.apiKey) {
    credentialRef = id;
    storeSecret(credentialRef, body.apiKey);
  }

  const conn: ModelConnection = {
    id,
    role: role as ModelConnection["role"],
    mode: "api_key",
    provider: body.provider,
    endpoint: body.endpoint,
    model: body.model,
    credential_ref: credentialRef,
    verified_at: null,
  };

  setAppState("model_onboarding_state", "in_progress");

  try {
    await healthCheck(conn);
  } catch (err) {
    if (credentialRef) deleteSecret(credentialRef);
    return c.json(
      { error: `connection failed health check: ${(err as Error).message}` },
      422,
    );
  }

  // Supersede any prior connection for this role only after the new one
  // verifies. We deactivate (clear verified_at) rather than delete, because
  // agent_runs.model_connection_id references these rows (FK enforced) and we
  // keep the run history. Drop the superseded secrets so they don't dangle.
  const superseded = db
    .prepare(
      "SELECT credential_ref FROM model_connections WHERE role = ? AND verified_at IS NOT NULL",
    )
    .all(conn.role) as { credential_ref: string | null }[];
  for (const prior of superseded) {
    if (prior.credential_ref) deleteSecret(prior.credential_ref);
  }
  db.prepare(
    "UPDATE model_connections SET verified_at = NULL, credential_ref = NULL WHERE role = ? AND verified_at IS NOT NULL",
  ).run(conn.role);

  db.prepare(
    `INSERT INTO model_connections (id, role, mode, provider, endpoint, model, credential_ref, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, conn.role, conn.mode, conn.provider, conn.endpoint, conn.model, credentialRef);

  setAppState("model_onboarding_state", "satisfied");
  return c.json({ id, verified: true });
});

// Explicit disconnect (plan §7f). We clear verified_at/credential_ref rather
// than deleting the row, same reasoning as the supersede-on-reconnect path
// above: agent_runs.model_connection_id references these rows (FK enforced),
// and clearing keeps run history resolvable while dropping the dangling
// secret.
models.delete("/engine/models/:id", (c) => {
  const id = c.req.param("id");
  const row = db
    .prepare("SELECT credential_ref FROM model_connections WHERE id = ?")
    .get(id) as { credential_ref: string | null } | undefined;
  if (!row) return c.json({ error: "connection not found" }, 404);

  if (row.credential_ref) deleteSecret(row.credential_ref);

  db.prepare(
    "UPDATE model_connections SET verified_at = NULL, credential_ref = NULL WHERE id = ?",
  ).run(id);

  return c.json({ ok: true });
});
