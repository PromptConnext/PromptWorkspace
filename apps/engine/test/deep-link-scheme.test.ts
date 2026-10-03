// The ADR 0014 browser handoff has to come back to the shell that started it.
// An OS resolves a URL scheme to exactly one handler, so each host shell
// declares its own scheme via PROMPTWORKSPACE_DEEP_LINK_SCHEME when it spawns the
// engine. This checks that declaration actually reaches the web sign-in page:
// if the scheme stops riding on the login URL, sign-in silently completes in
// whichever shell happens to own the scheme on that machine.
//
// Run:  node --test apps/engine/test/deep-link-scheme.test.ts
// (env must be set BEFORE importing the SUT, so setup is top-level await.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pz-deeplink-"));
process.env.HOME = dataDir;
process.env.PROMPTWORKSPACE_DATA_DIR = dataDir;
process.env.CLOUD_API_URL = "http://127.0.0.1:1";
process.env.CLOUD_WEB_URL = "https://web.example";
// Browser login is supabase-mode only; stub mode 400s before building a URL.
process.env.SUPABASE_URL = "https://supabase.example";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.PROMPTWORKSPACE_DEEP_LINK_SCHEME = "promptworkspace-dev";
delete process.env.PROMPTWORKSPACE_AUTH_TOKEN;

const { Hono } = await import("hono");
const { cloud: cloudRoutes } = await import("../src/routes/cloud.ts");

const app = new Hono();
app.route("/", cloudRoutes);

test("the login URL carries the host shell's declared scheme", async () => {
  const res = await app.request("/engine/cloud/login/browser", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string; state: string };

  const url = new URL(body.url);
  assert.equal(url.origin, "https://web.example");
  assert.equal(url.pathname, "/login");
  assert.equal(url.searchParams.get("scheme"), "promptworkspace-dev");
  // The state still round-trips — the scheme is additive, not a replacement.
  assert.equal(url.searchParams.get("desktop"), "1");
  assert.equal(url.searchParams.get("state"), body.state);
  assert.match(body.state, /^[0-9a-f]{32}$/);
});
