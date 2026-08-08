import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import type { ProjectGraph } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

vi.mock("@/lib/api", () => ({
  listDocuments: vi.fn().mockResolvedValue([]),
  getStageDocument: vi.fn().mockResolvedValue({ id: null, stage: "specify", content: "", updated_at: null }),
}));

const originalFetch = global.fetch;
afterEach(() => {
  // This repo registers no global auto-cleanup (vitest.config.ts sets neither
  // `globals` nor `setupFiles`), so every rendering test file unmounts itself.
  cleanup();
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

const graph = {
  project: { id: "p1", name: "Proj" },
  requirements: [],
  spec_documents: [],
  tasks: [],
  artifacts: [],
  agent_runs: [],
  discussions: [],
} as unknown as ProjectGraph;

function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f + "\n\n"));
      controller.close();
    },
  });
}

function panel(open = true) {
  return render(
    <AssistantPanel
      open={open}
      onClose={vi.fn()}
      graph={graph}
      workspaceId="w1"
      projectId="p1"
    />,
  );
}

describe("AssistantPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = panel(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the empty state before any question", () => {
    panel();
    expect(screen.getByText(/grounded in this project/i)).toBeInTheDocument();
  });

  it("streams an answer and shows its citations", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"Two of four."}',
        'event: citations\ndata: {"citations":[{"node_type":"pull_requests","node_id":"4a91c2ff-aaaa","chunk_index":0,"source":"vector"}]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "how is it going?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("Two of four.")).toBeInTheDocument());
    expect(screen.getByText("pull request")).toBeInTheDocument();
  });

  it("offers a workspace settings link when no model is connected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: "model_connection_not_configured" }),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/no model is connected/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /workspace settings/i })).toHaveAttribute(
      "href",
      "/w/w1/settings",
    );
  });

  it("deep-links to the reindex section on an embed-model mismatch", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: "embed_model_mismatch: this project's chunks were embedded with 'a'" }),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /reindex/i })).toHaveAttribute(
        "href",
        "/w/w1/p/p1/settings#assistant-index",
      ),
    );
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
