// WP4 — origin allowlist + auth-token smoke tests (ADR 0008), no-token branch.
// Env must be set BEFORE importing the SUT: security.ts reads
// PROMPTCONNEXT_AUTH_TOKEN into a module-level const at import time.
//
// Run:  node --test apps/engine/test/security.test.ts
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.PROMPTCONNEXT_AUTH_TOKEN;
delete process.env.PROMPTCONNEXT_ALLOWED_ORIGINS;

const { isAllowedOrigin, isAuthorized, AUTH_TOKEN } = await import("../src/security.ts");

test("isAllowedOrigin accepts the packaged app and dev-server origins", () => {
  assert.equal(isAllowedOrigin("tauri://localhost"), true);
  assert.equal(isAllowedOrigin("https://tauri.localhost"), true);
  assert.equal(isAllowedOrigin("http://localhost:1420"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:1420"), true);
});

test("isAllowedOrigin rejects unlisted origins and non-string input", () => {
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  assert.equal(isAllowedOrigin(undefined), false);
  assert.equal(isAllowedOrigin(null), false);
  assert.equal(isAllowedOrigin(""), false);
});

test("AUTH_TOKEN is null when PROMPTCONNEXT_AUTH_TOKEN is unset (dev mode)", () => {
  assert.equal(AUTH_TOKEN, null);
});

test("isAuthorized is open (always true) when no token is configured", () => {
  assert.equal(isAuthorized(undefined, null), true);
  assert.equal(isAuthorized("Bearer anything", null), true);
  assert.equal(isAuthorized(undefined, "anything"), true);
});
