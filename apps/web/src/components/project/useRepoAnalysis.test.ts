import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRepoAnalysis } from "./useRepoAnalysis";
import type { RepoAnalysisOut } from "@/lib/types";

vi.mock("@/lib/auth", () => {
  const auth = { authHeaders: () => ({ Authorization: "Bearer test" }) };
  return { useAuth: () => auth };
});

const originalFetch = global.fetch;

// Chunks are enqueued as given, so a test can split a frame mid-line the way
// the network does.
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function analysis(overrides: Partial<RepoAnalysisOut> = {}): RepoAnalysisOut {
  return {
    project_id: "p1",
    status: "snapshot_ready",
    required: true,
    commit_sha: "abc1234",
    snapshot: null,
    baseline: "",
    updated_at: null,
    stale: null,
    ...overrides,
  };
}

describe("useRepoAnalysis", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("hands up the snapshot, streams the deltas, then hands up the final analysis", async () => {
    const snapshot = analysis();
    const done = { ...analysis({ status: "baseline_ready", baseline: "# Baseline" }), truncated: true };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        'data: {"delta":"# Base',
        'line"}\n\n',
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ]),
    }) as unknown as typeof fetch;
    const onAnalysis = vi.fn();

    const { result } = renderHook(() => useRepoAnalysis("p1", onAnalysis));
    await act(async () => {
      await result.current.analyze();
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.streamedText).toBe("# Baseline");
    expect(result.current.truncated).toBe(true);
    expect(onAnalysis).toHaveBeenCalledTimes(2);
    expect(onAnalysis.mock.calls[0][0]).toEqual(snapshot);
    // `truncated` belongs to the stream, not to the stored analysis.
    expect(onAnalysis.mock.calls[1][0]).toEqual(
      analysis({ status: "baseline_ready", baseline: "# Baseline" }),
    );
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/projects/p1/repo-analysis");
    expect(init.method).toBe("POST");
  });

  it("surfaces a mid-stream error event", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        `event: snapshot\ndata: ${JSON.stringify(analysis())}\n\n`,
        'event: error\ndata: {"error":"managed tier busy, try again later","retryable":true}\n\n',
      ]),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useRepoAnalysis("p1", vi.fn()));
    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toEqual({
      error: "managed tier busy, try again later",
      retryable: true,
    });
  });

  it("surfaces a refusal made before the stream opens as its detail code", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      body: null,
      json: async () => ({ detail: "github_not_configured" }),
    }) as unknown as typeof fetch;
    const onAnalysis = vi.fn();

    const { result } = renderHook(() => useRepoAnalysis("p1", onAnalysis));
    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toEqual({ error: "github_not_configured" });
    expect(onAnalysis).not.toHaveBeenCalled();
  });

  it("reports a stream that ends with no terminal event as a retryable error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(['data: {"delta":"partial"}\n\n']),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useRepoAnalysis("p1", vi.fn()));
    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.retryable).toBe(true);
  });
});
