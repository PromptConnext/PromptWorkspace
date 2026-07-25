// WP4 — auth-token smoke tests (ADR 0008), token-configured branch.
// AUTH_TOKEN is a module-level const read from process.env at import time,
// so this must live in its own file/process from security.test.ts (which
// asserts the no-token default) — see g2-roster.test.ts's header comment.
//
// Run:  node --test apps/engine/test/security-with-token.test.ts
import test from "node:test";
import assert from "node:assert/strict";

process.env.PROMPTCONNEXT_AUTH_TOKEN = "secret-123";

const { isAuthorized, AUTH_TOKEN } = await import("../src/security.ts");

test("AUTH_TOKEN reflects the configured session token", () => {
  assert.equal(AUTH_TOKEN, "secret-123");
});

test("isAuthorized accepts a matching Bearer header", () => {
  assert.equal(isAuthorized("Bearer secret-123", null), true);
});

test("isAuthorized accepts a raw header value with no Bearer prefix", () => {
  assert.equal(isAuthorized("secret-123", null), true);
});

test("isAuthorized accepts a matching query token (WS handshake path)", () => {
  assert.equal(isAuthorized(undefined, "secret-123"), true);
});

test("isAuthorized rejects a wrong Bearer header", () => {
  assert.equal(isAuthorized("Bearer wrong", null), false);
});

test("isAuthorized rejects when neither header nor query token is present", () => {
  assert.equal(isAuthorized(undefined, null), false);
});

test("isAuthorized rejects a wrong query token", () => {
  assert.equal(isAuthorized(undefined, "wrong"), false);
});
