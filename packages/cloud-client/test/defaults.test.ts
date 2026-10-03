// Run:  node --test packages/cloud-client/test/defaults.test.ts
//
// The four production client defaults live in src/defaults.ts. apps/mcp imports
// them; apps/vscode's package.json has to copy them, so this is the tripwire
// that keeps the two surfaces pointed at the same stack.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PRODUCTION_DEFAULTS } from "../src/defaults.ts";

// Walked up from the working directory, as taskRefs.test.ts does: this
// package's tsconfig emits CommonJS, so `import.meta.url` does not typecheck.
const MANIFEST_REL = join("apps", "vscode", "package.json");

function findManifest(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, MANIFEST_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find ${MANIFEST_REL} above ${process.cwd()}`);
    dir = parent;
  }
}

const vscodeManifest = JSON.parse(readFileSync(findManifest(), "utf8")) as { contributes: { configuration: { properties: Record<string, { default?: unknown }> } } };

const FIELDS = ["cloudApiUrl", "cloudWebUrl", "supabaseUrl", "supabaseAnonKey"] as const;

test("all four vscode package.json defaults equal the shared production defaults", () => {
  const props = vscodeManifest.contributes.configuration.properties;
  for (const field of FIELDS) {
    assert.equal(props[`promptworkspace.${field}`]?.default, PRODUCTION_DEFAULTS[field], field);
  }
});

test("the defaults point at the production domains", () => {
  assert.equal(PRODUCTION_DEFAULTS.cloudApiUrl, "https://workspace-api.promptconnext.com");
  assert.equal(PRODUCTION_DEFAULTS.cloudWebUrl, "https://workspace.promptconnext.com");
});

// The engine runs TypeScript natively with no dependency on this package, so
// apps/engine/src/config.ts carries its own copies of the two cloud URLs.
test("apps/engine's default cloud URLs equal the shared production defaults", () => {
  const engineConfig = readFileSync(join(dirname(findManifest()), "..", "engine", "src", "config.ts"), "utf8");
  const apiMatch = /const DEFAULT_CLOUD_API_URL = "([^"]*)";/.exec(engineConfig);
  const webMatch = /process\.env\.CLOUD_WEB_URL \|\| "([^"]*)"/.exec(engineConfig);
  assert.ok(apiMatch, "DEFAULT_CLOUD_API_URL not found in apps/engine/src/config.ts");
  assert.ok(webMatch, "CLOUD_WEB_URL default not found in apps/engine/src/config.ts");
  assert.equal(apiMatch[1], PRODUCTION_DEFAULTS.cloudApiUrl);
  assert.equal(webMatch[1], PRODUCTION_DEFAULTS.cloudWebUrl);
});

// Whether the Supabase placeholders have been filled is a release-time check,
// not a CI one: scripts/assert-defaults-filled.mjs runs from apps/vscode
// `vscode:prepublish` and apps/mcp `prepack` (docs/DEPLOYMENT.md §3A).
