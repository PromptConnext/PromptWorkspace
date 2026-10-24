// The shapes every tool handler answers with, shared by server.ts and the
// planning handlers. A tool error is a result with `isError`, never a throw, so
// the assistant can read it and act.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

export function failure(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`\`${key}\` must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}
