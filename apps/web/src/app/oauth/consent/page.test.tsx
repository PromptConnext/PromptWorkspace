import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { ConsentView } from "@/lib/types";
import ConsentPage from "./page";

let mockSearchParams = new URLSearchParams("request=req-1");
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const requireAuthNext = vi.fn();
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children, next }: { children: React.ReactNode; next?: string }) => {
    requireAuthNext(next);
    return <>{children}</>;
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ authorization: "Bearer tok" }) }),
}));

const getConsent = vi.fn();
const approveConsent = vi.fn();
const denyConsent = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ApiError: actual.ApiError,
    getConsent: (...a: unknown[]) => getConsent(...a),
    approveConsent: (...a: unknown[]) => approveConsent(...a),
    denyConsent: (...a: unknown[]) => denyConsent(...a),
  };
});

const base: ConsentView = {
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  logo_uri: "https://claude.ai/logo.png",
  vendor: "Anthropic",
  verified: true,
  redirect_host: "claude.ai",
  loopback: false,
  scopes: ["mcp"],
  account_email: "me@example.com",
  workspaces: [
    { id: "w1", name: "Acme" },
    { id: "w2", name: "Beta" },
  ],
  expires_at: "2026-10-25T00:10:00Z",
};

const assign = vi.fn();

beforeEach(() => {
  mockSearchParams = new URLSearchParams("request=req-1");
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function renderPage() {
  await act(async () => {
    render(<ConsentPage />);
  });
}

describe("OAuth consent page", () => {
  it("sends an unauthenticated visitor back here after login", async () => {
    mockSearchParams = new URLSearchParams({ request: "a b&c" });
    getConsent.mockResolvedValue(base);
    await renderPage();
    expect(requireAuthNext).toHaveBeenCalledWith("/oauth/consent?request=a%20b%26c");
  });

  it("shows a verified vendor with the scopes, workspaces and account", async () => {
    getConsent.mockResolvedValue(base);
    await renderPage();
    expect(getConsent).toHaveBeenCalledWith("req-1", { authorization: "Bearer tok" });
    expect(await screen.findByText("Anthropic wants to connect to PromptWorkspace.")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://claude.ai/logo.png");
    expect(screen.getByRole("link", { name: "https://claude.ai" })).toHaveAttribute("href", "https://claude.ai");
    expect(
      screen.getByText(
        "It can read and update your tasks and planning documents, and submit drafts for review, in these workspaces:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Signed in as me@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/Unverified/)).not.toBeInTheDocument();
  });

  it("shows a loopback client as an app on this computer", async () => {
    getConsent.mockResolvedValue({ ...base, loopback: true, verified: false, vendor: null });
    await renderPage();
    expect(
      await screen.findByText("An app on this computer wants to connect to PromptWorkspace."),
    ).toBeInTheDocument();
    expect(screen.getByText("Verified: loopback")).toBeInTheDocument();
  });

  it("warns about an unverified app and never renders non-https URLs", async () => {
    getConsent.mockResolvedValue({
      ...base,
      verified: false,
      vendor: "Anthropic",
      client_name: "Totally Claude",
      redirect_host: "evil.example",
      logo_uri: "http://evil.example/logo.png",
      client_uri: "javascript:alert(1)",
    });
    await renderPage();
    const warning = await screen.findByText("Unverified app — it will redirect to evil.example");
    expect(warning).toBeInTheDocument();
    expect(screen.getByText("Totally Claude")).toBeInTheDocument();
    expect(screen.queryByText(/wants to connect/)).not.toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("approves with the bearer and follows the redirect", async () => {
    getConsent.mockResolvedValue(base);
    approveConsent.mockResolvedValue({ redirect_to: "https://claude.ai/cb?code=c1&state=s" });
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://claude.ai/cb?code=c1&state=s"));
    expect(approveConsent).toHaveBeenCalledWith("req-1", { authorization: "Bearer tok" });
    expect(denyConsent).not.toHaveBeenCalled();
  });

  it("denies and follows the redirect", async () => {
    getConsent.mockResolvedValue(base);
    denyConsent.mockResolvedValue({ redirect_to: "http://127.0.0.1:5000/cb?error=access_denied" });
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5000/cb?error=access_denied"),
    );
    expect(denyConsent).toHaveBeenCalledWith("req-1", { authorization: "Bearer tok" });
  });

  it("follows Cursor's native cursor:// callback", async () => {
    getConsent.mockResolvedValue(base);
    approveConsent.mockResolvedValue({
      redirect_to: "cursor://anysphere.cursor-mcp/oauth/callback?code=x",
    });
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("cursor://anysphere.cursor-mcp/oauth/callback?code=x"),
    );
  });

  it("refuses a script redirect", async () => {
    getConsent.mockResolvedValue(base);
    approveConsent.mockResolvedValue({ redirect_to: "javascript:alert(1)" });
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("explains an expired request", async () => {
    getConsent.mockRejectedValue(new ApiError(404, "request_not_found"));
    await renderPage();
    expect(
      await screen.findByText("This request has expired. Start the connection again from your agent."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("explains an answered request", async () => {
    getConsent.mockRejectedValue(new ApiError(409, "request_decided"));
    await renderPage();
    expect(await screen.findByText("This request was already answered.")).toBeInTheDocument();
  });

  it("explains a request answered between load and click", async () => {
    getConsent.mockResolvedValue(base);
    approveConsent.mockRejectedValue(new ApiError(409, "request_decided"));
    await renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("This request was already answered.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
