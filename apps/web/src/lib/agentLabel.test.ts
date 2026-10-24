import { describe, expect, it } from "vitest";
import { agentLabel } from "./agentLabel";

describe("agentLabel", () => {
  it("mcp:cursor reads Closed via Cursor (MCP)", () => {
    expect(agentLabel({ client: "mcp:cursor", model: null })).toBe("Closed via Cursor (MCP)");
  });
  it("vscode:Cursor reads Closed via Cursor (editor)", () => {
    expect(agentLabel({ client: "vscode:Cursor" })).toBe("Closed via Cursor (editor)");
  });
  it("bare mcp reads Closed via an MCP client", () => {
    expect(agentLabel({ client: "mcp", model: "x" })).toBe("Closed via an MCP client");
  });
  it("no agent reads Closed on the web", () => {
    expect(agentLabel(null)).toBe("Closed on the web");
    expect(agentLabel(undefined)).toBe("Closed on the web");
  });
});
