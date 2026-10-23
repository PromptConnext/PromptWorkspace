import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { LineNotificationsPanel } from "./LineNotificationsPanel";

const getLineStatus = vi.fn();
const createLineLinkCode = vi.fn();
const disconnectLine = vi.fn();
const sendLineTest = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getLineStatus: (...a: unknown[]) => getLineStatus(...a),
    createLineLinkCode: (...a: unknown[]) => createLineLinkCode(...a),
    disconnectLine: (...a: unknown[]) => disconnectLine(...a),
    sendLineTest: (...a: unknown[]) => sendLineTest(...a),
  };
});
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ authHeaders: () => ({}) }) }));

const NOT_CONNECTED = {
  configured: true,
  connected: false,
  group_name: null,
  linked_at: null,
  bot_basic_id: "@pwbot",
};
const CONNECTED = {
  configured: true,
  connected: true,
  group_name: "Ops team",
  linked_at: "2026-10-20T09:00:00Z",
  bot_basic_id: "@pwbot",
};

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("LineNotificationsPanel", () => {
  it("shows setup copy when LINE is not configured", async () => {
    getLineStatus.mockResolvedValue({ ...NOT_CONNECTED, configured: false });
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    expect(
      await screen.findByText("LINE notifications are not set up on this server."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect LINE group" })).toBeNull();
  });

  it("admin generates a code and sees the link command", async () => {
    getLineStatus.mockResolvedValue(NOT_CONNECTED);
    createLineLinkCode.mockResolvedValue({
      code: "PW-ABC123",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      bot_basic_id: "@pwbot",
    });
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect LINE group" }));
    expect(await screen.findByText("link PW-ABC123")).toBeInTheDocument();
    expect(screen.getByText(/1\. Add the PromptWorkspace bot to your LINE group/)).toHaveTextContent(
      "1. Add the PromptWorkspace bot to your LINE group (@pwbot).",
    );
    const bot = screen.getByRole("link", { name: "@pwbot" });
    expect(bot).toHaveAttribute("href", "https://line.me/R/ti/p/%40pwbot");
    expect(bot).toHaveAttribute("target", "_blank");
    expect(bot.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("button", { name: "Check connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("switches to connected when the status poll reports a group", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getLineStatus.mockResolvedValueOnce(NOT_CONNECTED).mockResolvedValue(CONNECTED);
    createLineLinkCode.mockResolvedValue({
      code: "PW-ABC123",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      bot_basic_id: null,
    });
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect LINE group" }));
    await screen.findByText("link PW-ABC123");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(await screen.findByText(/Connected to Ops team since/)).toBeInTheDocument();
    const calls = getLineStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(getLineStatus.mock.calls.length).toBe(calls);
  });

  it("admin sends a test message", async () => {
    getLineStatus.mockResolvedValue(CONNECTED);
    sendLineTest.mockResolvedValueOnce({});
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Send test message" }));
    expect(await screen.findByText("Test message sent.")).toBeInTheDocument();
    sendLineTest.mockRejectedValueOnce(new ApiError(502, "line_send_failed"));
    await userEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(
      await screen.findByText("Could not send the test message. Try again."),
    ).toBeInTheDocument();
  });

  it("admin disconnects", async () => {
    getLineStatus.mockResolvedValueOnce(CONNECTED).mockResolvedValue(NOT_CONNECTED);
    disconnectLine.mockResolvedValue({});
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(disconnectLine).toHaveBeenCalledWith("p1", {});
    expect(
      await screen.findByRole("button", { name: "Connect LINE group" }),
    ).toBeInTheDocument();
  });

  it("members see status without actions", async () => {
    getLineStatus.mockResolvedValueOnce(NOT_CONNECTED);
    const { unmount } = render(<LineNotificationsPanel projectId="p1" isAdmin={false} />);
    expect(await screen.findByText("Not connected to a LINE group.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    getLineStatus.mockResolvedValueOnce(CONNECTED);
    render(<LineNotificationsPanel projectId="p1" isAdmin={false} />);
    expect(await screen.findByText(/Connected to Ops team since/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("step 1 has no bot link when the server names no bot", async () => {
    getLineStatus.mockResolvedValue(NOT_CONNECTED);
    createLineLinkCode.mockResolvedValue({
      code: "PW-ABC123",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      bot_basic_id: null,
    });
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect LINE group" }));
    expect(
      await screen.findByText("1. Add the PromptWorkspace bot to your LINE group."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("leaves out the date when the link has none", async () => {
    getLineStatus.mockResolvedValue({ ...CONNECTED, linked_at: null });
    render(<LineNotificationsPanel projectId="p1" isAdmin={false} />);
    expect(await screen.findByText("Connected to Ops team.")).toBeInTheDocument();
  });

  it("maps admin_required and hides unknown error codes", async () => {
    getLineStatus.mockResolvedValue(CONNECTED);
    disconnectLine.mockRejectedValueOnce(new ApiError(403, "admin_required"));
    render(<LineNotificationsPanel projectId="p1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText("Only workspace admins can change this."),
    ).toBeInTheDocument();
    sendLineTest.mockRejectedValueOnce(new ApiError(500, "line_link_store_failed"));
    await userEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(await screen.findByText("Something went wrong. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("line_link_store_failed")).toBeNull();
  });
});
