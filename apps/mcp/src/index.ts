#!/usr/bin/env node
//
// Entry point. Two modes, because an MCP client launches this with no arguments
// and expects a stdio server on the other end, while a human needs somewhere to
// sign in first.

import { configDir } from "./config.ts";
import { runLogin } from "./login.ts";
import { runServer } from "./server.ts";

const USAGE = `promptconnext-mcp — your assigned PromptConnext tasks, over MCP.

  promptconnext-mcp            Run the stdio MCP server (what an MCP client launches).
  promptconnext-mcp login      Sign in through the browser and store the session.
  promptconnext-mcp --help     This message.

Configuration lives in ${configDir()}/config.json and is overridable by
PROMPTCONNEXT_CLOUD_API_URL, PROMPTCONNEXT_CLOUD_WEB_URL,
PROMPTCONNEXT_SUPABASE_URL and PROMPTCONNEXT_SUPABASE_ANON_KEY.
`;

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command === undefined || command === "serve") return runServer();
  if (command === "login") return runLogin();
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // stderr, never stdout: in server mode stdout is the JSON-RPC channel.
    process.stderr.write(`[promptconnext-mcp] fatal: ${String(err)}\n`);
    process.exitCode = 1;
  },
);
