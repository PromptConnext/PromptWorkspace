// Run:  node --test apps/vscode/test/unit/repoUrl.test.ts
//
// The guard half is ported from apps/engine (clone-url-validation.test.ts) and
// keeps the same threat model: `ext::sh -c` is RCE, a leading `-` is argument
// injection. The matching half is new, and exists because a real clone almost
// never spells its remote the way the cloud spells repo_url.

import test from "node:test";
import assert from "node:assert/strict";

import {
  UnsafeRepoUrlError,
  assertCloneableRepoUrl,
  isCloneableRepoUrl,
  normalizeRepoUrl,
  sameRepo,
} from "../../src/link/repoUrl.ts";

test("accepts the two forms a git host actually hands out", () => {
  assert.equal(
    assertCloneableRepoUrl("https://github.com/acme/app.git"),
    "https://github.com/acme/app.git",
  );
  assert.equal(
    assertCloneableRepoUrl("git@github.com:acme/app.git"),
    "git@github.com:acme/app.git",
  );
});

test("rejects the transports that are remote code execution", () => {
  for (const url of [
    "ext::sh -c 'touch /tmp/pwned'",
    "file:///etc/passwd",
    "ssh://user@host/repo",
    "http://insecure.example/repo.git",
  ]) {
    assert.throws(() => assertCloneableRepoUrl(url), UnsafeRepoUrlError, url);
  }
});

test("rejects a URL that would be read as a git flag", () => {
  assert.throws(
    () => assertCloneableRepoUrl("--upload-pack=touch /tmp/pwned"),
    UnsafeRepoUrlError,
  );
});

test("rejects empty and non-string input", () => {
  assert.throws(() => assertCloneableRepoUrl(""), UnsafeRepoUrlError);
  assert.throws(() => assertCloneableRepoUrl("   "), UnsafeRepoUrlError);
  assert.throws(() => assertCloneableRepoUrl(null), UnsafeRepoUrlError);
  assert.equal(isCloneableRepoUrl(undefined), false);
});

test("the same repository matches across spellings", () => {
  const cloud = "https://github.com/Acme/App.git";
  for (const remote of [
    "git@github.com:acme/app.git",
    "https://github.com/acme/app",
    "https://github.com/acme/app/",
    "https://token@github.com/acme/app.git",
  ]) {
    assert.ok(sameRepo(remote, cloud), remote);
  }
});

test("different repositories do not match", () => {
  assert.equal(
    sameRepo("https://github.com/acme/app.git", "https://github.com/acme/other.git"),
    false,
  );
  assert.equal(
    sameRepo("https://gitlab.com/acme/app.git", "https://github.com/acme/app.git"),
    false,
  );
});

test("unparseable input is 'no match', never 'matches everything'", () => {
  assert.equal(normalizeRepoUrl(""), null);
  assert.equal(normalizeRepoUrl(null), null);
  assert.equal(sameRepo(null, null), false);
  assert.equal(sameRepo("", ""), false);
});
