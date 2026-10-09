// Run:  node --test packages/cloud-client/test/repoUrl.test.ts
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
  projectsMatchingRemotes,
  remotesMatch,
  sameRepo,
} from "../src/repoUrl.ts";

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

// SSH host aliases (finding #35): a developer with two GitHub accounts writes
// `Host github.com-work` in ~/.ssh/config and clones from
// `git@github.com-work:org/repo`. `git remote -v` shows the alias, so a
// host+path comparison never matched and the open folder read "not cloned".

test("github.com-9haroon:org/repo matches https://github.com/org/repo as alias", () => {
  assert.equal(
    remotesMatch("git@github.com-9haroon:org/repo.git", "https://github.com/org/repo"),
    "alias",
  );
  assert.equal(
    remotesMatch("ssh://git@github.com-work/Org/Repo", "https://github.com/org/repo.git"),
    "alias",
  );
  // The real host is still an exact match, never downgraded to an alias.
  assert.equal(remotesMatch("git@github.com:org/repo.git", "https://github.com/org/repo"), "exact");
});

test("a different path never matches", () => {
  for (const remote of [
    "git@github.com-work:org/other.git",
    "git@github.com-work:someone-else/repo.git",
    "git@github.com-work:org/repo/extra.git",
    // Same suffix trick on a different base host.
    "git@gitlab.com-work:org/repo.git",
    // A hyphen inside a label is part of a real host name, not an alias.
    "git@my-github.com:org/repo.git",
    // An alias with no base host to compare against.
    "git@work:org/repo.git",
    // Hostile suffixes: a real host that merely starts with the base host,
    // and a different base host carrying a suffix.
    "git@github.com-evil.com:org/repo",
    "git@notgithub.com-x:org/repo",
    // An alias with an explicit port names a server, not just an account:
    // the alias claim is too weak to carry it.
    "ssh://git@github.com-work:2222/org/repo",
  ]) {
    assert.equal(remotesMatch(remote, "https://github.com/org/repo"), "none", remote);
  }
  assert.equal(remotesMatch("", "https://github.com/org/repo"), "none");
  assert.equal(remotesMatch("git@github.com-work:org/repo", ""), "none");
});

test("an alias that matches two roster projects is ambiguous and links neither", () => {
  const roster = [
    { projectId: "p1", repoUrl: "https://github.com/org/repo" },
    { projectId: "p2", repoUrl: "https://github.com/org/repo.git" },
    { projectId: "p3", repoUrl: "https://github.com/org/other" },
  ];
  const alias = ["git@github.com-work:org/repo.git"];
  assert.deepEqual(projectsMatchingRemotes(alias, roster), []);

  // One alias candidate links; the ambiguity is the only thing refused.
  assert.deepEqual(
    projectsMatchingRemotes(alias, [roster[0], roster[2]]).map((p) => p.projectId),
    ["p1"],
  );
  // Exact matches keep today's behaviour: several are offered for a pick, and
  // they win over any alias candidate.
  assert.deepEqual(
    projectsMatchingRemotes(["git@github.com:org/repo.git"], roster).map((p) => p.projectId),
    ["p1", "p2"],
  );
  assert.deepEqual(
    projectsMatchingRemotes(
      ["git@github.com:org/repo.git", "git@github.com-work:org/other.git"],
      [roster[0], roster[2]],
    ).map((p) => p.projectId),
    ["p1"],
  );
  assert.deepEqual(projectsMatchingRemotes(alias, [{ projectId: "p4", repoUrl: null }]), []);
});
