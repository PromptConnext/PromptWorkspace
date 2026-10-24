/** Human label for which client closed a task (from `Artifact.agent`). */
export function agentLabel(
  agent: { client: string; model?: string | null } | null | undefined,
): string {
  if (!agent) return "Closed on the web";
  const { client } = agent;
  if (client === "mcp") return "Closed via an MCP client";
  if (client.startsWith("mcp:")) {
    const name = client.slice(4);
    return `Closed via ${name.charAt(0).toUpperCase()}${name.slice(1)} (MCP)`;
  }
  if (client.startsWith("vscode:")) return `Closed via ${client.slice(7)} (editor)`;
  return "Closed on the web";
}
