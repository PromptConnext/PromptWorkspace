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
  const conns = listConnections();
  // Degrade within what's connected (architecture §3.3): exact role first,
  // then any verified connection.
  return (
    conns.find((c) => c.role === role && c.verified_at) ??
    conns.find((c) => c.verified_at)
  );
}

export { chat };

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

  db.prepare(
    `INSERT INTO model_connections (id, role, mode, provider, endpoint, model, credential_ref, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, conn.role, conn.mode, conn.provider, conn.endpoint, conn.model, credentialRef);

  setAppState("model_onboarding_state", "satisfied");
  return c.json({ id, verified: true });
});
