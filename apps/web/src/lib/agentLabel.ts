/**
 * Human label for which client closed a task (from `Artifact.agent`).
 *
 * The web board never writes artifacts, so an artifact with no agent came from
 * the push webhook (it has a commit), the engine, or history: say "by a push"
 * for a commit and nothing for the rest rather than guessing.
 */
export function agentLabel(
  agent: { client: string; model?: string | null } | null | undefined,
  hasCommit: boolean,
): string | null {
  if (!agent) return hasCommit ? "Closed by a push" : null;
  const { client } = agent;
  if (client === "mcp") return "Closed via an MCP client";
  if (client.startsWith("mcp:")) {
    const name = client.slice(4);
    if (!name) return "Closed via an MCP client";
    return `Closed via ${name.charAt(0).toUpperCase()}${name.slice(1)} (MCP)`;
  }
  if (client.startsWith("vscode:")) {
    const name = client.slice(7);
    return name ? `Closed via ${name} (editor)` : "Closed via an editor";
  }
  return client ? `Closed via ${client}` : hasCommit ? "Closed by a push" : null;
}
