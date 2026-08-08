import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import { listDocuments } from "@/lib/api";
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

  // Regression for review finding 1: the Escape handler used to call
  // onClose() directly instead of the panel's own close(), which is the only
  // path that calls reset(). Since DiscussionThread never unmounts this
  // component (it only toggles `open`), useAssistantChat's unmount-abort
  // effect never got a chance to run either — an Escape-close left the
  // transcript on screen and the stream running underneath it.
  it("clears the transcript on Escape and does not resurface it on the next session", async () => {
    const onClose = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"Two of four."}',
        'event: citations\ndata: {"citations":[]}',
      ),
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    await userEvent.type(screen.getByRole("textbox"), "how is it going?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText("Two of four.")).toBeInTheDocument());

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();

    // Simulate the parent flipping `open` false then true again for the next
    // session, to prove the turn is really gone rather than just hidden
    // while the component stays mounted.
    rerender(
      <AssistantPanel open={false} onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    rerender(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );

    expect(screen.queryByText("Two of four.")).not.toBeInTheDocument();
    expect(screen.getByText(/grounded in this project/i)).toBeInTheDocument();
  });

  it("aborts the in-flight request when closed via Escape", async () => {
    const onClose = vi.fn();
    let capturedSignal: AbortSignal | undefined;
    global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      // Never resolves — stands in for a stream that is still in flight.
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    render(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    await userEvent.type(screen.getByRole("textbox"), "how is it going?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await userEvent.keyboard("{Escape}");

    expect(capturedSignal?.aborted).toBe(true);
  });

  // Regression for review finding 2: `resolved` used to latch true forever,
  // so the document/stage-document label lookup fired at most once for the
  // whole page visit even though the spec calls for once per panel session.
  // close() now re-arms it, so a citation of that kind in a later session
  // triggers a fresh fetch instead of trusting a cache that may be stale
  // (the Planner tab can rename/replace stage documents while this panel is
  // parked open on the Discussion tab).
  it("re-fetches document labels each panel session rather than once per mount", async () => {
    const onClose = vi.fn();
    vi.mocked(listDocuments).mockResolvedValue([
      {
        id: "doc1",
        project_id: "p1",
        title: "PRD v1",
        mime: "text/markdown",
        source_kind: "upload",
        extract_method: null,
        status: "extracted",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    ]);
    // mockImplementation (not mockResolvedValue) so each call gets its own
    // fresh ReadableStream — reusing one across two fetches throws "Invalid
    // state: ReadableStream is locked" on the second read.
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        body: sseBody(
          'data: {"delta":"See the PRD."}',
          'event: citations\ndata: {"citations":[{"node_type":"documents","node_id":"doc1","chunk_index":0,"source":"vector"}]}',
        ),
      }),
    ) as unknown as typeof fetch;

    const { rerender } = render(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    await userEvent.type(screen.getByRole("textbox"), "what does the PRD say?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText("PRD v1")).toBeInTheDocument());
    expect(listDocuments).toHaveBeenCalledTimes(1);

    // Close (Escape -> close()) and open a fresh session.
    await userEvent.keyboard("{Escape}");
    rerender(
      <AssistantPanel open={false} onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    rerender(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );

    await userEvent.type(screen.getByRole("textbox"), "what does the PRD say, again?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });

  // Review finding 3: the kind-gating on the Retry control (offered only for
  // "other" and "cut_off") had implementation but no coverage.
  it("offers Retry for a cut-off answer, and Retry re-asks the question", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        // No citations frame — the generator died mid-body.
        body: sseBody('data: {"delta":"partial"}'),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: sseBody(
          'data: {"delta":"full answer"}',
          'event: citations\ndata: {"citations":[]}',
        ),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/cut off/i)).toBeInTheDocument());
    const retryButton = screen.getByRole("button", { name: /retry/i });

    await userEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText("full answer")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers Retry for a generic network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("offers neither Retry nor a link when the daily budget is exhausted", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ detail: "daily_token_budget_exceeded" }),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/daily assistant budget/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // Review finding 4 (spec gap): the spec calls for focus to move to the
  // composer on open and *back to the trigger on close* — only the first
  // half was implemented.
  it("restores focus to the triggering element on close", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Ask the assistant
          </button>
          <AssistantPanel
            open={open}
            onClose={() => setOpen(false)}
            graph={graph}
            workspaceId="w1"
            projectId="p1"
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /ask the assistant/i });
    trigger.focus();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    expect(screen.getByRole("textbox")).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
