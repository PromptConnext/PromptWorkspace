// One place that assembles a CloudClient, so the `login` subcommand and the
// stdio server cannot drift into two different notions of where the session is.

import { randomUUID } from "node:crypto";
import {
  CloudClient,
  SessionStore,
  StatusQueue,
  type LoggerLike,
  type QueueEntry,
} from "@promptworkspace/cloud-client";
import { ensureConfigDir, readConfig, type McpConfig } from "./config.ts";
import { JsonState, KeychainSecrets, QUEUE_FILE } from "./tokenStore.ts";

/** Everything goes to stderr. stdout is the JSON-RPC channel when this process
 *  is a stdio server, and a stray line on it corrupts the stream for the client
 *  — a failure that shows up as an unrelated parse error much later. */
export const stderrLog: LoggerLike = {
  info: (message) => process.stderr.write(`[promptworkspace-mcp] ${message}\n`),
  warn: (message) => process.stderr.write(`[promptworkspace-mcp] warn: ${message}\n`),
  error: (message) => process.stderr.write(`[promptworkspace-mcp] error: ${message}\n`),
};

export interface CloudContext {
  client: CloudClient;
  session: SessionStore;
  config: McpConfig;
  queue: StatusQueue;
}

/** The pending status writes, in a file of their own under `dir`.
 *
 *  File-backed rather than in-memory because the process is disposable: an MCP
 *  client starts and kills this server around a single conversation, and a
 *  queued write that lived only in memory would be lost by the next question.
 *  Exported so a test can point one at a temp directory and prove exactly
 *  that. */
export function createStatusQueue(dir: string): StatusQueue {
  const state = new JsonState(dir, QUEUE_FILE);
  return new StatusQueue({
    load: async () => state.get<QueueEntry[]>("entries"),
    save: (entries) => state.update("entries", entries),
    now: () => Date.now(),
    newId: () => randomUUID(),
  });
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
  return { client, session, config, queue: createStatusQueue(dir) };
}
