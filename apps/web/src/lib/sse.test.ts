import { describe, expect, it } from "vitest";
import { parseFrames } from "./sse";

// Frames are separated by a blank line, exactly as
// apps/cloud/app/api/assistant.py writes them ("…\n\n").
function frames(...raw: string[]): string {
  return raw.map((r) => r + "\n\n").join("");
}

describe("parseFrames", () => {
  it("keeps a named mid-stream event from leaking into the frames after it", () => {
    const buffer = frames(
      'event: facts\ndata: {"title":"Login"}',
      'data: {"delta":"Two of "}',
      'data: {"delta":"four tasks"}',
      'event: citations\ndata: {"citations":[]}',
    );

    const { frames: out, rest } = parseFrames(buffer);

    expect(rest).toBe("");
    expect(out.map((f) => f.event)).toEqual(["facts", "message", "message", "citations"]);
    expect(out[0].data).toEqual({ title: "Login" });
    expect(out[1].data).toEqual({ delta: "Two of " });
  });

  it("returns an incomplete trailing frame as rest and emits it once completed", () => {
    const first = parseFrames('data: {"delta":"a"}\n\ndata: {"del');
    expect(first.frames).toEqual([{ event: "message", data: { delta: "a" } }]);
    expect(first.rest).toBe('data: {"del');

    const second = parseFrames(first.rest + 'ta":"b"}\n\n');
    expect(second.frames).toEqual([{ event: "message", data: { delta: "b" } }]);
    expect(second.rest).toBe("");
  });

  it("handles CRLF line endings", () => {
    const { frames: out } = parseFrames('event: facts\r\ndata: {"a":1}\r\n\r\n');
    expect(out).toEqual([{ event: "facts", data: { a: 1 } }]);
  });

  it("holds back a trailing CR that may be half of a split CRLF", () => {
    const first = parseFrames('data: {"delta":"a"}\r\n\r');
    expect(first.frames).toHaveLength(0);
    // CRLF inside the buffer is normalised; only the dangling CR is held back.
    expect(first.rest).toBe('data: {"delta":"a"}\n\r');

    const second = parseFrames(first.rest + "\n");
    expect(second.frames).toEqual([{ event: "message", data: { delta: "a" } }]);
    expect(second.rest).toBe("");
  });

  it("ignores comment lines and strips one leading space after data:", () => {
    const { frames: out } = parseFrames(': keep-alive\ndata: {"delta":"x"}\n\n');
    expect(out).toEqual([{ event: "message", data: { delta: "x" } }]);
  });

  it("joins multi-line data with a newline", () => {
    const { frames: out } = parseFrames('data: {"delta":\ndata: "hello"}\n\n');
    expect((out[0].data as { delta: string }).delta).toBe("hello");
  });

  it("passes unknown event names through unchanged", () => {
    const { frames: out } = parseFrames('event: something_new\ndata: {}\n\n');
    expect(out[0].event).toBe("something_new");
  });

  it("drops a frame with unparseable JSON without discarding later frames", () => {
    const { frames: out } = parseFrames('data: not json\n\ndata: {"delta":"ok"}\n\n');
    expect(out).toEqual([{ event: "message", data: { delta: "ok" } }]);
  });

  it("returns empty results for an empty buffer", () => {
    expect(parseFrames("")).toEqual({ frames: [], rest: "" });
  });
});
