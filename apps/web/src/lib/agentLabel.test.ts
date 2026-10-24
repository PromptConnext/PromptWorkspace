import { describe, expect, it } from "vitest";
import { agentLabel } from "./agentLabel";

describe("agentLabel", () => {
  it("mcp:cursor reads Closed via Cursor (MCP)", () => {
    expect(agentLabel({ client: "mcp:cursor", model: null }, false)).toBe("Closed via Cursor (MCP)");
  });
  it("vscode:Cursor reads Closed via Cursor (editor)", () => {
    expect(agentLabel({ client: "vscode:Cursor" }, true)).toBe("Closed via Cursor (editor)");
  });
  it("bare mcp reads Closed via an MCP client", () => {
    expect(agentLabel({ client: "mcp", model: "x" }, false)).toBe("Closed via an MCP client");
  });
  it("mcp: with an empty name reads Closed via an MCP client", () => {
    expect(agentLabel({ client: "mcp:" }, false)).toBe("Closed via an MCP client");
  });
  it("an unknown client string reads Closed via <client>", () => {
    expect(agentLabel({ client: "zed" }, false)).toBe("Closed via zed");
  });
  it("no agent and a commit reads Closed by a push", () => {
    expect(agentLabel(null, true)).toBe("Closed by a push");
    expect(agentLabel(undefined, true)).toBe("Closed by a push");
  });
  it("no agent and no commit has no label", () => {
    expect(agentLabel(null, false)).toBeNull();
    expect(agentLabel(undefined, false)).toBeNull();
  });
});
