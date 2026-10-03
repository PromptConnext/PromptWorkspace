// Plan §7f — Connection management (disconnect) UI: DELETE /engine/models/:id
// clears verified_at/credential_ref and drops the keychain secret, mirroring
// the supersede-on-reconnect logic in the connect handler (models.ts). Row is
// cleared, not hard-deleted, because agent_runs.model_connection_id
// references model_connections (FK enforced) and run history must stay
// resolvable.
//
// Follows keychain.test.ts's real-OS-keychain round-trip and wp2-conflicts's
// real in-process Hono app pattern — no mocking. Env must be set before
// importing the SUT (db.ts + config.ts read it at import time).
//
// The keychain-secret assertion is opt-in behind PROMPTWORKSPACE_TEST_KEYCHAIN=1,
// same as keychain.test.ts: a sandboxed/headless session has no unlocked login
// keychain, so `security add-generic-password` falls back to a blocking
// "Keychain Not Found"/authorization GUI dialog that never resolves headlessly
// instead of failing cleanly.
//
// Run:  PROMPTWORKSPACE_TEST_KEYCHAIN=1 node --test apps/engine/test/models-disconnect.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pz-models-disconnect-"));
process.env.HOME = dataDir;
process.env.PROMPTWORKSPACE_DATA_DIR = dataDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTWORKSPACE_AUTH_TOKEN;

const { Hono } = await import("hono");
const { models: modelRoutes } = await import("../src/routes/models.ts");
const { db } = await import("../src/db.ts");
const { storeSecret, readSecret } = await import("../src/keychain.ts");

const app = new Hono();
app.route("/", modelRoutes);

const req = (path: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

function insertConnection(credentialRef: string | null): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO model_connections (id, role, mode, provider, endpoint, model, credential_ref, verified_at)
     VALUES (?, 'code', 'api_key', 'openai', 'https://example.test', 'gpt-test', ?, datetime('now'))`,
  ).run(id, credentialRef);
  return id;
}

test("DELETE /engine/models/:id clears verified_at/credential_ref and drops the keychain secret", async (t) => {
  if (process.platform === "linux") {
    t.skip("keychain.ts has no libsecret implementation on Linux (see its module header)");
    return;
  }
  if (process.env.PROMPTWORKSPACE_TEST_KEYCHAIN !== "1") {
    t.skip("set PROMPTWORKSPACE_TEST_KEYCHAIN=1 to run against a real OS keychain (avoids the blocking 'Keychain Not Found' dialog in sandboxed/headless runs)");
    return;
  }

  const ref = `test-${randomUUID()}`;
  storeSecret(ref, "s3cr3t-value");
  assert.equal(readSecret(ref), "s3cr3t-value", "sanity: secret is stored before disconnect");

  const id = insertConnection(ref);

  const res = await req(`/engine/models/${id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);

  const row = db
    .prepare("SELECT verified_at, credential_ref FROM model_connections WHERE id = ?")
    .get(id) as { verified_at: string | null; credential_ref: string | null };
  assert.equal(row.verified_at, null, "verified_at is cleared");
  assert.equal(row.credential_ref, null, "credential_ref is cleared");

  assert.equal(readSecret(ref), null, "the keychain secret was deleted");
});

test("DELETE /engine/models/:id on a connection with no credential still clears verified_at", async () => {
  const id = insertConnection(null);

  const res = await req(`/engine/models/${id}`, { method: "DELETE" });
  assert.equal(res.status, 200);

  const row = db
    .prepare("SELECT verified_at FROM model_connections WHERE id = ?")
    .get(id) as { verified_at: string | null };
  assert.equal(row.verified_at, null);
});

test("DELETE /engine/models/:id 404s for an unknown id", async () => {
  const res = await req(`/engine/models/${randomUUID()}`, { method: "DELETE" });
  assert.equal(res.status, 404);
});
