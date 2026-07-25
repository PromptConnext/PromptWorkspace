import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStageGeneration } from "./useStageGeneration";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
}

describe("useStageGeneration", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    global.fetch = originalFetch;
    localStorage.clear();
  });

  it("accumulates delta text while streaming, then resolves with the done payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        'data: {"delta":"Hello "}',
        'data: {"delta":"world"}',
        "event: done",
        'data: {"stage":"specify","title":"T","content":"Hello world","requirement_id":"r1"}',
      ]),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useStageGeneration("p1"));

    await act(async () => {
      await result.current.generate("specify", "do the thing");
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.streamedText).toBe("Hello world");
    expect(result.current.result?.requirement_id).toBe("r1");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a structured error event without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        "event: error",
        'data: {"error":"managed tier busy, try again","retryable":true}',
      ]),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useStageGeneration("p1"));

    await act(async () => {
      await result.current.generate("plan", "plan it");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.retryable).toBe(true);
    expect(result.current.error?.error).toMatch(/managed tier busy/);
  });
});
