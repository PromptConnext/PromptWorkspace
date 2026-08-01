import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConnectionForm } from "./ModelConnectionForm";
import type { ModelConnectionStatus } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

const BYO: ModelConnectionStatus = {
  configured: true,
  connection: {
    provider: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    embed_model: "text-embedding-3-small",
    embed_dim: 1536,
    daily_token_budget: 200000,
    updated_at: "2026-08-01T00:00:00Z",
  },
  chat_source: "byo",
  embed_source: "byo",
};

const NONE: ModelConnectionStatus = {
  configured: false,
  connection: null,
  chat_source: "none",
  embed_source: "none",
};

// Each call records the POST body so a test can assert what was actually sent.
const posted: unknown[] = [];

function mockFetch(status: ModelConnectionStatus, postFailure?: { detail: string }) {
  global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("/model-connection") && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      if (postFailure) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ detail: postFailure.detail }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    if (href.includes("/model-connection")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => status });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

async function fillKeyAndSubmit() {
  fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: /connect|replace/i }));
}

describe("ModelConnectionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("warns that the assistant cannot answer when nothing is connected", async () => {
    mockFetch(NONE);
    render(<ModelConnectionForm workspaceId="ws-1" />);

    expect(await screen.findByText(/no model connected/i)).toBeInTheDocument();
    expect(screen.getByText(/there is no fallback model/i)).toBeInTheDocument();
  });

  it("reports the platform model when the workspace has none of its own", async () => {
    mockFetch({ ...NONE, chat_source: "managed", embed_source: "managed" });
    render(<ModelConnectionForm workspaceId="ws-1" />);

    expect(await screen.findByText(/using the platform model/i)).toBeInTheDocument();
    expect(screen.queryByText(/no model connected/i)).not.toBeInTheDocument();
  });

  it("says content questions are unavailable when only embeddings are missing", async () => {
    mockFetch({ ...NONE, chat_source: "managed", embed_source: "none" });
    render(<ModelConnectionForm workspaceId="ws-1" />);

    expect(await screen.findByText(/not about the content of your documents/i)).toBeInTheDocument();
  });

  it("shows the connected model and offers to replace it", async () => {
    mockFetch(BYO);
    render(<ModelConnectionForm workspaceId="ws-1" />);

    expect(await screen.findByText("gpt-4o-mini")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /replace connection/i }),
    ).toBeInTheDocument();
  });

  it("posts the connection with numeric fields coerced from the inputs", async () => {
    mockFetch(NONE);
    render(<ModelConnectionForm workspaceId="ws-1" />);
    await screen.findByText(/no model connected/i);

    await fillKeyAndSubmit();

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      provider: "openai",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      embed_model: "text-embedding-3-small",
      embed_dim: 1536,
      daily_token_budget: 200000,
      api_key: "sk-test-key",
    });
  });

  it("explains a rejected key instead of showing the raw error code", async () => {
    mockFetch(NONE, { detail: "model_connection_health_check_failed" });
    render(<ModelConnectionForm workspaceId="ws-1" />);
    await screen.findByText(/no model connected/i);

    await fillKeyAndSubmit();

    expect(await screen.findByText(/could not be used to generate an embedding/i)).toBeInTheDocument();
    expect(screen.queryByText(/model_connection_health_check_failed/)).not.toBeInTheDocument();
  });
});
