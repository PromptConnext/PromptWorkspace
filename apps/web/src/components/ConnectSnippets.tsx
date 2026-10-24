"use client";

import { useState } from "react";

function mcpUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/mcp`;
}

export function claudeCodeCommand(apiUrl: string): string {
  return `claude mcp add --transport http promptworkspace ${mcpUrl(apiUrl)}`;
}

// Cursor's install link (cursor.com/docs/context/mcp/install-links) takes
// standard, padded base64 of the JSON config, URL-encoded as a query value.
function base64Param(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return encodeURIComponent(btoa(binary));
}

export function cursorDeeplink(apiUrl: string): string {
  const config = base64Param(JSON.stringify({ url: mcpUrl(apiUrl) }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=promptworkspace&config=${config}`;
}

export function cursorJson(apiUrl: string): string {
  return JSON.stringify({ mcpServers: { promptworkspace: { url: mcpUrl(apiUrl) } } });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard refused (insecure context, permissions); the text is
          // still on screen to select by hand.
        }
      }}
      className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-1 flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-slate-50 px-2 py-1 text-xs text-slate-800">
        {text}
      </code>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/** How to point each supported coding agent at this deployment's hosted MCP endpoint. */
export function ConnectSnippets({ apiUrl }: { apiUrl: string }) {
  const url = mcpUrl(apiUrl);
  return (
    <div className="space-y-4 text-sm text-slate-700">
      <div>
        <p className="font-medium text-slate-900">Claude Code</p>
        <Snippet text={claudeCodeCommand(apiUrl)} label="Copy Claude Code command" />
      </div>
      <div>
        <p className="font-medium text-slate-900">Cursor</p>
        <a
          href={cursorDeeplink(apiUrl)}
          className="mt-1 inline-block rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
        >
          Add to Cursor
        </a>
        <p className="mt-2 text-xs text-slate-500">Or add this to your Cursor MCP settings:</p>
        <Snippet text={cursorJson(apiUrl)} label="Copy Cursor configuration" />
      </div>
      <div>
        <p className="font-medium text-slate-900">Claude.ai and ChatGPT: add a custom connector with</p>
        <Snippet text={url} label="Copy connector URL" />
      </div>
    </div>
  );
}
