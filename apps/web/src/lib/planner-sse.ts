//
// Parses the backend's SSE framing (apps/cloud/app/api/generation.py::stream):
// a bare "data: {...}" line is a "message" event (a streamed delta chunk);
// an "event: done"/"event: error" line followed by "data: {...}" is that
// named terminal event. One line in, current parse state out — a pure
// function so it's testable without a real fetch/ReadableStream.

export type SseParseState = { event: "message" | "done" | "error"; data: unknown } | null;

export function parseSseLine(line: string, prev: SseParseState): SseParseState {
  if (line.startsWith("event:")) {
    const event = line.slice("event:".length).trim();
    if (event === "done" || event === "error") {
      return { event, data: prev?.data ?? null };
    }
    return prev;
  }
  if (line.startsWith("data:")) {
    const raw = line.slice("data:".length).trim();
    if (!raw) return prev;
    const data = JSON.parse(raw);
    // A bare data: line with no preceding event: line this frame is a
    // "message" (delta) event, per the backend's framing.
    const event = prev && prev.event !== "message" ? prev.event : "message";
    return { event, data };
  }
  return prev;
}
