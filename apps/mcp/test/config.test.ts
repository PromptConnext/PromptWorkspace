// Run:  node --test apps/mcp/test/config.test.ts
//
// The README promises that setting `supabaseUrl` / `supabaseAnonKey` to empty
// puts the client in the cloud's stub auth mode. That only holds if an
// explicitly empty value survives `readConfig` instead of falling back to the
// production Supabase project — which is what this file pins. The API and web
// URLs are different: an empty one is never a usable configuration, so those
// keep falling back to the defaults.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, readConfig } from "../src/config.ts";

function withConfigDir(file?: Record<string, string>): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "pw-mcp-config-"));
  if (file) writeFileSync(join(dir, "config.json"), JSON.stringify(file));
  return { dir, env: { PROMPTWORKSPACE_MCP_CONFIG_DIR: dir } };
}

test("unset everywhere falls back to the production defaults", () => {
  const { dir, env } = withConfigDir();
  try {
    assert.deepEqual(readConfig(env), DEFAULTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty PROMPTWORKSPACE_SUPABASE_URL / _ANON_KEY in env selects stub mode", () => {
  const { dir, env } = withConfigDir();
  try {
    const config = readConfig({
      ...env,
      PROMPTWORKSPACE_CLOUD_API_URL: "http://localhost:8080",
      PROMPTWORKSPACE_SUPABASE_URL: "",
      PROMPTWORKSPACE_SUPABASE_ANON_KEY: "",
    });
    assert.equal(config.cloudApiUrl, "http://localhost:8080");
    assert.equal(config.supabaseUrl, "");
    assert.equal(config.supabaseAnonKey, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty supabaseUrl / supabaseAnonKey in config.json selects stub mode", () => {
  const { dir, env } = withConfigDir({
    cloudApiUrl: "http://localhost:8080",
    supabaseUrl: "",
    supabaseAnonKey: "",
  });
  try {
    const config = readConfig(env);
    assert.equal(config.supabaseUrl, "");
    assert.equal(config.supabaseAnonKey, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env wins over the file even when env empties a value the file sets", () => {
  const { dir, env } = withConfigDir({ supabaseUrl: "https://file.supabase.co" });
  try {
    assert.equal(readConfig({ ...env, PROMPTWORKSPACE_SUPABASE_URL: "" }).supabaseUrl, "");
    assert.equal(readConfig(env).supabaseUrl, "https://file.supabase.co");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty cloudApiUrl or cloudWebUrl still falls back to the default", () => {
  const { dir, env } = withConfigDir({ cloudApiUrl: "", cloudWebUrl: "   " });
  try {
    const config = readConfig({ ...env, PROMPTWORKSPACE_CLOUD_API_URL: "" });
    assert.equal(config.cloudApiUrl, DEFAULTS.cloudApiUrl);
    assert.equal(config.cloudWebUrl, DEFAULTS.cloudWebUrl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
