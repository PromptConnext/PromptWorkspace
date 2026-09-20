// Settings.
//
// apps/vscode reads these from VS Code settings because nothing sets env for an
// extension host. An MCP server has the opposite problem: a client launches a
// bare process with no settings mechanism at all, and often no inherited shell
// either. So both paths exist — a JSON file the `login` subcommand can sit
// beside, and environment variables for the clients that do pass env through.
//
// The four names are apps/vscode/src/config.ts's names, deliberately unchanged:
// `cloudApiUrl`, `cloudWebUrl`, `supabaseUrl`, `supabaseAnonKey`. `projectId`,
// `closeTasksFromCommits` and `commitScanLimit` have no analogue here — there is
// no folder scope, no watcher, and this milestone writes nothing.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpConfig {
  cloudApiUrl: string;
  cloudWebUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

// Same values as apps/vscode/package.json's `contributes.configuration`
// defaults. If one moves, both move.
const DEFAULTS: McpConfig = {
  cloudApiUrl: "https://p01--promptconnect-cloud-api--sj64fy5ygbzy.code.run",
  cloudWebUrl: "https://prompt-zone-web-app.vercel.app",
  supabaseUrl: "",
  supabaseAnonKey: "",
};

// Prefixed rather than the engine's bare `CLOUD_API_URL` / `SUPABASE_URL`. The
// engine is started by a shell we control; this process is started by someone
// else's MCP client, in whatever environment the developer happens to have, and
// an unrelated project's `SUPABASE_URL` silently redirecting our auth is a
// failure mode worth spending a prefix to avoid.
const ENV_KEYS: Record<keyof McpConfig, string> = {
  cloudApiUrl: "PROMPTCONNEXT_CLOUD_API_URL",
  cloudWebUrl: "PROMPTCONNEXT_CLOUD_WEB_URL",
  supabaseUrl: "PROMPTCONNEXT_SUPABASE_URL",
  supabaseAnonKey: "PROMPTCONNEXT_SUPABASE_ANON_KEY",
};

export const CONFIG_FILE = "config.json";

/** Where the config file and the token store live.
 *
 *  XDG everywhere except Windows, which has no XDG convention and where
 *  apps/engine's keychain fallback already writes under %APPDATA%. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PROMPTCONNEXT_MCP_CONFIG_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const base = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "promptconnext-mcp");
  }
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "promptconnext-mcp");
}

/** Create the config directory if it is missing. 0700 because the token store
 *  lives inside it — see tokenStore.ts for what that does and does not buy. */
export function ensureConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readConfigFile(dir: string): Partial<McpConfig> {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Partial<McpConfig>;
  } catch {
    // A malformed config must not stop the server from starting: the defaults
    // plus env are still a working configuration, and stdout is not ours to
    // complain on.
    return {};
  }
}

/** Precedence, lowest to highest: built-in default, config file, environment. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const file = readConfigFile(configDir(env));
  const pick = (key: keyof McpConfig): string => {
    const fromEnv = env[ENV_KEYS[key]];
    if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
    const fromFile = file[key];
    if (typeof fromFile === "string" && fromFile.trim()) return fromFile.trim();
    return DEFAULTS[key];
  };
  return {
    cloudApiUrl: trimSlash(pick("cloudApiUrl")),
    cloudWebUrl: trimSlash(pick("cloudWebUrl")),
    supabaseUrl: trimSlash(pick("supabaseUrl")),
    supabaseAnonKey: pick("supabaseAnonKey"),
  };
}
