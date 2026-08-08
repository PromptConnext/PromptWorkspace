import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Default admin=true so the pre-existing link-rendering tests below don't
// need to know this mock exists. The two "non-admin" tests (finding 1) flip
// it per-test.
const isWorkspaceAdmin = vi.fn();
vi.mock("@/lib/workspace", () => ({
  useIsWorkspaceAdmin: (...args: unknown[]) => isWorkspaceAdmin(...args),
}));

const originalFetch = global.fetch;
beforeEach(() => {
  isWorkspaceAdmin.mockReturnValue(true);
});
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

  // Finding 3: aria-live="polite" alone on the transcript makes assistive
  // tech re-announce the growing answer on every delta (a 200-delta answer
  // would produce ~200 announcements). aria-busy tells the AT to hold off
  // until the region settles, then announce once.
  it("marks the transcript region busy while a turn streams and idle once it settles", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
          await gate;
          controller.enqueue(encoder.encode('event: citations\ndata: {"citations":[]}\n\n'));
          controller.close();
        },
      }),
    }) as unknown as typeof fetch;

    panel();
    const region = screen.getByRole("dialog").querySelector('[aria-live="polite"]');
    expect(region).toHaveAttribute("aria-busy", "false");

    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(region).toHaveAttribute("aria-busy", "true"));

    await act(async () => {
      release();
    });
    await waitFor(() => expect(region).toHaveAttribute("aria-busy", "false"));
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

  // Finding 1: the two links above render unconditionally, regardless of the
  // signed-in user's role. require_admin would 403 a member who follows
  // either one anyway, so the spec calls for explanatory copy and no link.
  it("offers no settings link to a non-admin when no model is connected, only explanatory copy", async () => {
    isWorkspaceAdmin.mockReturnValue(false);
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
    expect(screen.getByText(/ask a workspace admin to connect one/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /workspace settings/i })).not.toBeInTheDocument();
  });

  it("offers no reindex link to a non-admin on an embed-model mismatch, only explanatory copy", async () => {
    isWorkspaceAdmin.mockReturnValue(false);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        detail: "embed_model_mismatch: this project's chunks were embedded with 'a'",
      }),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/indexed with a different embedding model/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/ask an admin to reindex it/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /reindex/i })).not.toBeInTheDocument();
  });

  // Task 10: retrieval transparency — a content answer that was never
  // grounded looks identical in its prose to one the corpus genuinely can't
  // answer, so the server says which via a `retrieval` SSE frame.
  it("shows the no-embed-model notice with an admin link to workspace settings", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"I don\'t have enough information."}',
        'event: retrieval\ndata: {"grounded":false,"reason":"no_embed_model"}',
        'event: citations\ndata: {"citations":[]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "explain the PRD");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/no embedding model is connected/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /workspace settings/i })).toHaveAttribute(
      "href",
      "/w/w1/settings",
    );
  });

  it("shows ask-an-admin copy instead of a link for a non-admin on the no-embed-model notice", async () => {
    isWorkspaceAdmin.mockReturnValue(false);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"I don\'t have enough information."}',
        'event: retrieval\ndata: {"grounded":false,"reason":"no_embed_model"}',
        'event: citations\ndata: {"citations":[]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "explain the PRD");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/no embedding model is connected/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/ask a workspace admin to connect one/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /workspace settings/i })).not.toBeInTheDocument();
  });

  it("shows the no-indexed-content notice with an admin link to reindex", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"I don\'t have enough information."}',
        'event: retrieval\ndata: {"grounded":false,"reason":"no_indexed_content"}',
        'event: citations\ndata: {"citations":[]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "explain the PRD");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/no indexed content yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /reindex this project/i })).toHaveAttribute(
      "href",
      "/w/w1/p/p1/settings#assistant-index",
    );
  });

  it("shows ask-an-admin copy instead of a link for a non-admin on the no-indexed-content notice", async () => {
    isWorkspaceAdmin.mockReturnValue(false);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"I don\'t have enough information."}',
        'event: retrieval\ndata: {"grounded":false,"reason":"no_indexed_content"}',
        'event: citations\ndata: {"citations":[]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "explain the PRD");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/no indexed content yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/ask an admin to reindex it/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /reindex this project/i })).not.toBeInTheDocument();
  });

  it("renders no retrieval notice when no retrieval frame arrives", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"Two of four."}',
        'event: citations\ndata: {"citations":[]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "how is it going?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("Two of four.")).toBeInTheDocument());
    expect(screen.queryByText(/isn't grounded/i)).not.toBeInTheDocument();
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

  // Finding 2: Retry had no `disabled` guard (unlike the composer), so it was
  // a second, ungated entry point into run(). Clicking an older turn's Retry
  // while a newer turn streams calls run() again, which aborts the newer
  // turn's controller; that turn's reader.read() then rejects AbortError and
  // useAssistantChat's catch returns before any patch() — the newer turn is
  // stranded at status "streaming" forever, with no way to recover short of
  // closing the panel.
  it("disables an older turn's Retry while a newer turn is still streaming, so the newer turn is never stranded", async () => {
    let releaseTurnTwo: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTurnTwo = resolve;
    });
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn()
      // Turn 1: cut off, no citations frame.
      .mockResolvedValueOnce({
        ok: true,
        body: sseBody('data: {"delta":"partial"}'),
      })
      // Turn 2: gated open so it is still "streaming" when Retry is clicked.
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          body: new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode('data: {"delta":"turn two "}\n\n'));
              await gate;
              controller.enqueue(encoder.encode('data: {"delta":"answer"}\n\n'));
              controller.enqueue(
                encoder.encode('event: citations\ndata: {"citations":[]}\n\n'),
              );
              controller.close();
            },
          }),
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "first");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/cut off/i)).toBeInTheDocument());

    await userEvent.type(screen.getByRole("textbox"), "second");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/turn two/i)).toBeInTheDocument());

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeDisabled();
    await userEvent.click(retryButton);
    // Still 2: the disabled button swallowed the click, so no third request
    // (which would have aborted turn 2's controller) was ever made.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseTurnTwo();
    });
    await waitFor(() => expect(screen.getByText("turn two answer")).toBeInTheDocument());
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
