import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectSnippets, claudeCodeCommand, cursorDeeplink } from "./ConnectSnippets";

const API = "https://api.example.com";

afterEach(cleanup);

describe("ConnectSnippets", () => {
  it("builds the Claude Code command", () => {
    expect(claudeCodeCommand(API)).toBe(
      "claude mcp add --transport http promptworkspace https://api.example.com/mcp",
    );
    // A trailing slash on the configured URL must not produce "//mcp".
    expect(claudeCodeCommand(`${API}/`)).toBe(
      "claude mcp add --transport http promptworkspace https://api.example.com/mcp",
    );
  });

  it("encodes the Cursor config as URL-encoded, padded standard base64", () => {
    const link = cursorDeeplink(API);
    const prefix = "cursor://anysphere.cursor-deeplink/mcp/install?name=promptworkspace&config=";
    expect(link.startsWith(prefix)).toBe(true);
    const config = link.slice(prefix.length);
    expect(decodeURIComponent(config)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodeURIComponent(config).length % 4).toBe(0);
    expect(JSON.parse(atob(decodeURIComponent(config)))).toEqual({ url: "https://api.example.com/mcp" });
  });

  it("renders the three forms with the API URL", () => {
    render(<ConnectSnippets apiUrl={API} />);
    expect(
      screen.getByText("claude mcp add --transport http promptworkspace https://api.example.com/mcp"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add to Cursor" })).toHaveAttribute(
      "href",
      cursorDeeplink(API),
    );
    expect(
      screen.getByText('{"mcpServers":{"promptworkspace":{"url":"https://api.example.com/mcp"}}}'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Claude\.ai and ChatGPT: add a custom connector with/)).toBeInTheDocument();
    expect(screen.getAllByText("https://api.example.com/mcp").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /copy/i })).toHaveLength(3);
  });

  it("copies a snippet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ConnectSnippets apiUrl={API} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy Claude Code command" }));
    expect(writeText).toHaveBeenCalledWith(
      "claude mcp add --transport http promptworkspace https://api.example.com/mcp",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy Claude Code command" })).toHaveTextContent("Copied"),
    );
  });
});
