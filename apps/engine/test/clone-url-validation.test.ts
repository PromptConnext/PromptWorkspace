// Security hardening for cloneLocalProjectShell (plan 0016/phase 6): repoUrl
// arrives from the cloud roster, a separate trust boundary from the engine.
// assertCloneableRepoUrl must reject anything that could be interpreted as a
// git option or an unsafe transport BEFORE any git process is spawned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env must be set before importing the SUT (db.ts + config.ts read it at import).
const dataDir = mkdtempSync(join(tmpdir(), "pz-clone-url-validation-"));
process.env.HOME = dataDir;
process.env.PROMPTCONNEXT_DATA_DIR = dataDir;
delete process.env.CLOUD_API_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTCONNEXT_AUTH_TOKEN;

const { assertCloneableRepoUrl, CloneFailedError } = await import("../src/routes/projects.ts");

test("rejects the ext:: transport (arbitrary shell command execution)", () => {
  assert.throws(() => assertCloneableRepoUrl("ext::sh -c id"), CloneFailedError);
});

test("rejects a URL starting with '-' (git flag injection, e.g. --upload-pack=)", () => {
  assert.throws(() => assertCloneableRepoUrl("--upload-pack=touch /tmp/pwned"), CloneFailedError);
  assert.throws(() => assertCloneableRepoUrl("-oProxyCommand=id"), CloneFailedError);
});

test("rejects file:// URLs", () => {
  assert.throws(() => assertCloneableRepoUrl("file:///etc"), CloneFailedError);
  assert.throws(() => assertCloneableRepoUrl("file:///etc/passwd"), CloneFailedError);
});

test("rejects a plain garbage string", () => {
  assert.throws(() => assertCloneableRepoUrl("not a url at all"), CloneFailedError);
  assert.throws(() => assertCloneableRepoUrl(""), CloneFailedError);
});

test("rejects other unsanctioned transports (git://, ssh://)", () => {
  assert.throws(() => assertCloneableRepoUrl("git://example.com/acme/repo.git"), CloneFailedError);
  assert.throws(() => assertCloneableRepoUrl("ssh://git@example.com/acme/repo.git"), CloneFailedError);
});

test("accepts a normal https:// GitHub-style URL", () => {
  assert.doesNotThrow(() => assertCloneableRepoUrl("https://github.com/acme/repo.git"));
});

test("accepts an https:// URL against a self-hosted GitHub Enterprise host", () => {
  assert.doesNotThrow(() =>
    assertCloneableRepoUrl("https://git.enterprise.acme-corp.internal/acme/repo.git"),
  );
});

test("accepts the git@<host>: SSH shorthand", () => {
  assert.doesNotThrow(() => assertCloneableRepoUrl("git@github.com:acme/repo.git"));
  assert.doesNotThrow(() =>
    assertCloneableRepoUrl("git@git.enterprise.acme-corp.internal:acme/repo.git"),
  );
});
