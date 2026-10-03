// WP4 — real OS keychain round-trip (macOS `security` CLI / Windows DPAPI).
// Skipped on Linux: keychain.ts has no libsecret implementation (see its
// header comment) and darwinStore/darwinRead/darwinDelete would shell out to
// a nonexistent `security` CLI and throw.
//
// Opt-in only: a sandboxed/headless session has no login keychain for the
// `security` CLI to write into, so it falls back to a blocking native
// "Keychain Not Found" GUI dialog instead of failing cleanly — that dialog
// would otherwise pop on every `node --test` run. Set
// PROMPTWORKSPACE_TEST_KEYCHAIN=1 to run this against a real, unlocked
// keychain (e.g. an interactive local machine or a CI runner known to have
// one).
//
// Run:  PROMPTWORKSPACE_TEST_KEYCHAIN=1 node --test apps/engine/test/keychain.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { storeSecret, readSecret, deleteSecret } from "../src/keychain.ts";

test("storeSecret/readSecret/deleteSecret round-trip through the real OS keychain", async (t) => {
  if (process.platform === "linux") {
    t.skip("keychain.ts has no libsecret implementation on Linux (see module header)");
    return;
  }
  if (process.env.PROMPTWORKSPACE_TEST_KEYCHAIN !== "1") {
    t.skip("set PROMPTWORKSPACE_TEST_KEYCHAIN=1 to run against a real OS keychain (avoids the blocking 'Keychain Not Found' dialog in sandboxed/headless runs)");
    return;
  }

  const ref = `test-${randomUUID()}`;
  try {
    storeSecret(ref, "s3cr3t-value");
    assert.equal(readSecret(ref), "s3cr3t-value", "the stored secret reads back verbatim");
  } finally {
    deleteSecret(ref);
  }

  assert.equal(readSecret(ref), null, "the entry is gone after delete");
});

test("readSecret returns null for a credential ref that was never stored", (t) => {
  if (process.platform === "linux") {
    t.skip("keychain.ts has no libsecret implementation on Linux (see module header)");
    return;
  }
  if (process.env.PROMPTWORKSPACE_TEST_KEYCHAIN !== "1") {
    t.skip("set PROMPTWORKSPACE_TEST_KEYCHAIN=1 to run against a real OS keychain (avoids the blocking 'Keychain Not Found' dialog in sandboxed/headless runs)");
    return;
  }
  assert.equal(readSecret(`test-never-stored-${randomUUID()}`), null);
});
