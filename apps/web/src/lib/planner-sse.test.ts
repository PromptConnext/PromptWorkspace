import { describe, expect, it } from "vitest";
import { parseSseLine, type SseParseState } from "./planner-sse";

describe("parseSseLine", () => {
  it("parses a bare data line as a message-event delta", () => {
    let state: SseParseState = null;
    state = parseSseLine('data: {"delta":"hello"}', state);
    expect(state).toEqual({ event: "message", data: { delta: "hello" }, fresh: true });
  });

  it("parses an event: line followed by a data: line as that event type", () => {
    let state: SseParseState = null;
    state = parseSseLine("event: done", state);
    state = parseSseLine('data: {"stage":"specify","content":"# Spec"}', state);
    expect(state).toEqual({
      event: "done",
      data: { stage: "specify", content: "# Spec" },
      fresh: true,
    });
  });

  it("parses an error event", () => {
    let state: SseParseState = null;
    state = parseSseLine("event: error", state);
    state = parseSseLine('data: {"error":"boom","retryable":true}', state);
    expect(state).toEqual({
      event: "error",
      data: { error: "boom", retryable: true },
      fresh: true,
    });
  });

  it("keeps data/event from before a blank line (frame separator) but marks it not fresh", () => {
    let state: SseParseState = null;
    state = parseSseLine('data: {"delta":"a"}', state);
    const before = state;
    state = parseSseLine("", state);
    expect(state).toEqual({ ...before, fresh: false });
  });
});
