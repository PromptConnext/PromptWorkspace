import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat } from "./useAssistantChat";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

// Frames, not lines. apps/cloud/app/api/assistant.py terminates every frame
// with a blank line; joining with a single "\n" (as useStageGeneration.test.ts
// does for the other endpoint) would produce zero complete frames here.
function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f + "\n\n"));
      controller.close();
    },
  });
}

function mockStream(...frames: string[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: sseBody(...frames),
  }) as unknown as typeof fetch;
}

function mockFailure(status: number, detail: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ detail }),
  }) as unknown as typeof fetch;
}

describe("useAssistantChat", () => {
  it("accumulates deltas into one turn and records citations", async () => {
    mockStream(
      'data: {"delta":"Two of "}',
      'data: {"delta":"four tasks."}',
      'event: citations\ndata: {"citations":[{"node_type":"tasks","node_id":"t1","chunk_index":0,"source":"vector"}]}',
    );

    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("how is it going?");
    });

    const turn = result.current.turns[0];
    expect(turn.question).toBe("how is it going?");
    expect(turn.answer).toBe("Two of four tasks.");
    expect(turn.citations).toHaveLength(1);
    expect(turn.status).toBe("done");
  });

  it("stores lineage facts from the facts frame", async () => {
    mockStream(
      'event: facts\ndata: {"scope":"requirement","node_type":"requirements","node_id":"r1","title":"Login","status":"in_progress","specs_total":2,"tasks_total":4,"tasks_done":2,"task_status_counts":{"todo":1},"artifacts_total":3,"agent_runs":[]}',
      'data: {"delta":"Two of four."}',
    );

    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("status?");
    });

    expect(result.current.turns[0].facts?.title).toBe("Login");
    expect(result.current.turns[0].facts?.tasks_done).toBe(2);
  });

  it("treats the budget-exhausted-with-facts stream as a success, not an error", async () => {
    // apps/cloud/app/api/assistant.py:267-282 — 200 with a canned delta.
    mockStream(
      'event: facts\ndata: {"scope":"task","node_type":"tasks","node_id":"t1","title":"T","status":"todo","specs_total":0,"tasks_total":0,"tasks_done":0,"task_status_counts":{},"artifacts_total":0,"agent_runs":[]}',
      'data: {"delta":"Daily assistant budget reached — showing lineage facts only."}',
      'event: citations\ndata: {"citations":[]}',
    );

    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("status?");
    });

    expect(result.current.turns[0].status).toBe("done");
    expect(result.current.turns[0].error).toBeNull();
    expect(result.current.turns[0].facts).not.toBeNull();
  });

  it("classifies a missing model connection", async () => {
    mockFailure(400, "model_connection_not_configured");
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].error?.kind).toBe("no_model");
    expect(result.current.turns[0].status).toBe("error");
  });

  it("classifies an embed-model mismatch from the detail prefix", async () => {
    // The 409's detail is a full sentence, not a bare identifier
    // (apps/cloud/app/api/assistant.py:243-252) — matching must be by prefix.
    mockFailure(
      409,
      "embed_model_mismatch: this project's chunks were embedded with 'a'; reindex required before switching to 'b' (POST /projects/p1/assistant/reindex)",
    );
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].error?.kind).toBe("embed_mismatch");
  });

  it("classifies the hard budget rejection", async () => {
    mockFailure(429, "daily_token_budget_exceeded");
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].error?.kind).toBe("budget");
  });

  it("keeps partial text and flags a stream that ended without citations", async () => {
    mockStream('data: {"delta":"half an ans"}');
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].answer).toBe("half an ans");
    expect(result.current.turns[0].status).toBe("error");
    expect(result.current.turns[0].error?.kind).toBe("cut_off");
  });

  it("is busy while streaming and idle afterwards", async () => {
    // The stream is held open on a gate so `busy` can be observed mid-flight;
    // asserting it only before and after would pass even if it never flipped.
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

    const { result } = renderHook(() => useAssistantChat("p1"));
    expect(result.current.busy).toBe(false);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.ask("x");
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  it("does not clear busy when an aborted older run settles while a newer run is still streaming", async () => {
    // Turn A never produces a second chunk on its own — its stream only ever
    // settles via the abort that turn B's ask() issues against it. This
    // mirrors what a real fetch does: aborting the request rejects the
    // in-flight reader.read() with an AbortError.
    const encoder = new TextEncoder();
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    global.fetch = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
            // No further enqueue/close — this read only ever settles via abort.
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"delta":"b"}\n\n'));
            await gateB;
            controller.enqueue(encoder.encode('event: citations\ndata: {"citations":[]}\n\n'));
            controller.close();
          },
        }),
      })) as unknown as typeof fetch;

    const { result } = renderHook(() => useAssistantChat("p1"));

    let pendingA!: Promise<void>;
    act(() => {
      pendingA = result.current.ask("a?");
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    // Firing B aborts A's controller (still current at this point), then
    // installs B's controller as current before A's rejection is even
    // observed — that ordering is exactly what the `finally` guard checks.
    let pendingB!: Promise<void>;
    act(() => {
      pendingB = result.current.ask("b?");
    });

    // Let A's abort propagate through its catch/finally.
    await act(async () => {
      await pendingA;
    });

    // B is still streaming (gated on gateB) — busy must still read true.
    expect(result.current.busy).toBe(true);

    await act(async () => {
      releaseB();
      await pendingB;
    });
    expect(result.current.busy).toBe(false);
  });

  it("retry clears the turn's prior state before the new stream's content arrives, and does not concatenate old and new answers", async () => {
    // First attempt ends cut off (no citations frame), leaving the turn with
    // a partial answer, lineage facts, and an error.
    mockStream(
      'event: facts\ndata: {"scope":"task","node_type":"tasks","node_id":"t1","title":"T","status":"todo","specs_total":0,"tasks_total":0,"tasks_done":0,"task_status_counts":{},"artifacts_total":0,"agent_runs":[]}',
      'data: {"delta":"old partial"}',
    );
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    const turnId = result.current.turns[0].id;
    expect(result.current.turns[0].status).toBe("error");
    expect(result.current.turns[0].answer).toBe("old partial");
    expect(result.current.turns[0].facts).not.toBeNull();

    // Gate the retry's stream so the turn can be inspected before any new
    // content lands — proving the clear happens as part of retry() itself,
    // not just that the old text got overwritten by the time the test ends.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        async start(controller) {
          await gate;
          controller.enqueue(encoder.encode('data: {"delta":"new answer"}\n\n'));
          controller.enqueue(encoder.encode('event: citations\ndata: {"citations":[]}\n\n'));
          controller.close();
        },
      }),
    }) as unknown as typeof fetch;

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.retry(turnId);
    });

    await waitFor(() => {
      const t = result.current.turns.find((x) => x.id === turnId);
      expect(t?.status).toBe("streaming");
    });
    const cleared = result.current.turns.find((t) => t.id === turnId);
    expect(cleared?.answer).toBe("");
    expect(cleared?.facts).toBeNull();
    expect(cleared?.citations).toEqual([]);
    expect(cleared?.error).toBeNull();

    await act(async () => {
      release();
      await pending;
    });

    const final = result.current.turns.find((t) => t.id === turnId);
    expect(final?.status).toBe("done");
    expect(final?.error).toBeNull();
    expect(final?.answer).toBe("new answer");
  });

  it("clears turns on reset", async () => {
    mockStream('data: {"delta":"a"}', 'event: citations\ndata: {"citations":[]}');
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    act(() => result.current.reset());
    expect(result.current.turns).toHaveLength(0);
  });
});
