// One place that assembles a CloudClient, so the `login` subcommand and the
// stdio server cannot drift into two different notions of where the session is.

import { CloudClient, SessionStore, type LoggerLike } from "@promptconnext/pz-cloud";
import { ensureConfigDir, readConfig, type McpConfig } from "./config.ts";
import { JsonState, KeychainSecrets } from "./tokenStore.ts";

/** Everything goes to stderr. stdout is the JSON-RPC channel when this process
 *  is a stdio server, and a stray line on it corrupts the stream for the client
 *  — a failure that shows up as an unrelated parse error much later. */
export const stderrLog: LoggerLike = {
  info: (message) => process.stderr.write(`[promptconnext-mcp] ${message}\n`),
  warn: (message) => process.stderr.write(`[promptconnext-mcp] warn: ${message}\n`),
  error: (message) => process.stderr.write(`[promptconnext-mcp] error: ${message}\n`),
};

export interface CloudContext {
  client: CloudClient;
  session: SessionStore;
  config: McpConfig;
}

export function createCloudContext(log: LoggerLike = stderrLog): CloudContext {
  const dir = ensureConfigDir();
  const session = new SessionStore(new KeychainSecrets(dir), new JsonState(dir));
  // Re-read on every call rather than closing over one snapshot: `login` writes
  // the config file, and a long-lived server should pick that up without a
  // restart.
  const config = readConfig();
  const client = new CloudClient({
    session,
    config: () => {
      const current = readConfig();
      return {
        apiUrl: current.cloudApiUrl,
        supabaseUrl: current.supabaseUrl,
        supabaseAnonKey: current.supabaseAnonKey,
      };
    },
    fetch: (input, init) => fetch(input, init),
    log,
  });
  return { client, session, config };
}
