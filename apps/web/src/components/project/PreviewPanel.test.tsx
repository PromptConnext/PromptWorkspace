import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./PreviewPanel";
import type { DeploymentStatus } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;
const URL_LIVE = "https://preview.test/previews/p1/index.html";

function status(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    template_id: "static-r2",
    template_name: "Static site → PromptZone hosting",
    provider: "platform-r2",
    embeddable: true,
    state: "live",
    url: URL_LIVE,
    health_path: "/index.html",
    pending: 0,
    last_deploy: null,
    recent: [],
    last_error: null,
    ...overrides,
  };
}

function mockStatus(body: DeploymentStatus) {
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => body } as Response),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  mockStatus(status());
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PreviewPanel", () => {
  it("explains the empty state instead of showing a broken frame", async () => {
    mockStatus(status({ state: "not_configured", url: null, template_id: null }));
    render(<PreviewPanel projectId="p1" />);
    expect(await screen.findByText("No live preview yet")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("embeds a live, embeddable deploy and still offers a way out", async () => {
    render(<PreviewPanel projectId="p1" />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    const frame = document.querySelector("iframe")!;
    expect(frame).toHaveAttribute("src", URL_LIVE);
    expect(frame).toHaveAttribute("title");
    // The frame must never be able to navigate the workspace away.
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(screen.getByRole("link", { name: /Open in a new tab/i })).toHaveAttribute(
      "href",
      URL_LIVE,
    );
  });

  it("shows a link card and no iframe when the server measured a framing refusal", async () => {
    mockStatus(
      status({
        embeddable: false,
        last_deploy: {
          id: "d1",
          state: "live",
          url: URL_LIVE,
          commit_sha: "abc1234def",
          ref: "main",
          run_url: "https://github.test/run/1",
          frame_policy: "deny",
          created_at: "2026-08-19T00:00:00Z",
          updated_at: "2026-08-19T00:00:00Z",
        },
      }),
    );
    render(<PreviewPanel projectId="p1" />);

    expect(await screen.findByText("The live application is ready.")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });

  it("falls back to the link card when the handshake never arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PreviewPanel projectId="p1" />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    await vi.advanceTimersByTimeAsync(5000);

    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(screen.getByText(/could not confirm/i)).toBeInTheDocument();
  });

  it("keeps polling while a deploy is in flight, and stops once it lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockStatus(status({ state: "building", pending: 1, url: null }));
    render(<PreviewPanel projectId="p1" />);

    expect(await screen.findByText("Building the preview")).toBeInTheDocument();
    const afterFirstLoad = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    await vi.advanceTimersByTimeAsync(7000);
    const whilePolling = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(whilePolling).toBeGreaterThan(afterFirstLoad);

    // The deploy lands; the interval must stop rather than run forever.
    mockStatus(status());
    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(screen.getByText("Live preview")).toBeInTheDocument());

    const settled = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(settled);
  });

  it("reports a failure but keeps the last known good url reachable", async () => {
    mockStatus(
      status({
        state: "failed",
        url: URL_LIVE,
        last_error: {
          code: "build_failed",
          message: "workflow run failure",
          run_url: "https://github.test/run/2",
          at: "2026-08-19T00:00:00Z",
        },
      }),
    );
    render(<PreviewPanel projectId="p1" />);

    expect(await screen.findByText("The latest deploy failed")).toBeInTheDocument();
    expect(screen.getByText("workflow run failure")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open the build log/i })).toHaveAttribute(
      "href",
      "https://github.test/run/2",
    );
    // The point of last-known-good: the business user's link still works.
    expect(screen.getByRole("link", { name: /Open in a new tab/i })).toHaveAttribute(
      "href",
      URL_LIVE,
    );
  });

  it("never renders a progress bar while building", async () => {
    mockStatus(status({ state: "building", pending: 1, url: null }));
    render(<PreviewPanel projectId="p1" />);
    await screen.findByText("Building the preview");
    // A deploy's duration is unknown to the server, so any percentage would
    // be invented. ReindexPanel's rule, inherited deliberately.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
