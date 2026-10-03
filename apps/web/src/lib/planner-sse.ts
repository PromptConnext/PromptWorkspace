//
// Parses the backend's SSE framing (apps/cloud/app/api/generation.py::stream):
// a bare "data: {...}" line is a "message" event (a streamed delta chunk);
// an "event: done"/"event: error" line followed by "data: {...}" is that
// named terminal event. One line in, current parse state out — a pure
// function so it's testable without a real fetch/ReadableStream.

export type SseParseState = { event: "message" | "done" | "error"; data: unknown; fresh: boolean } | null;

export function parseSseLine(line: string, prev: SseParseState): SseParseState {
  if (line.startsWith("event:")) {
    const event = line.slice("event:".length).trim();
    if (event === "done" || event === "error") {
      return { event, data: prev?.data ?? null, fresh: false };
    }
    return prev && { ...prev, fresh: false };
  }
  if (line.startsWith("data:")) {
    const raw = line.slice("data:".length).trim();
    if (!raw) return prev && { ...prev, fresh: false };
    const data = JSON.parse(raw);
    // A bare data: line with no preceding event: line this frame is a
    // "message" (delta) event, per the backend's framing.
    const event = prev && prev.event !== "message" ? prev.event : "message";
    return { event, data, fresh: true };
  }
  return prev && { ...prev, fresh: false };
}

/**
 * The live preview of a stage generation, minus the ```file:<path> wrapper the
 * model is asked to put round the document (apps/cloud/app/generation/
 * prompts.py). The server unwraps the final document itself; this only keeps
 * the wrapper out of what the author watches arrive. A first line that is
 * still being streamed ("```fi…") is held back until it is complete, and a
 * closing fence — or the start of one — is dropped from the end.
 */
export function stripStreamFence(text: string): string {
  let out = text.replace(/^\s+/, "");
  if (out.startsWith("```")) {
    const newline = out.indexOf("\n");
    if (newline < 0) return "";
    if (/^```file:/.test(out)) out = out.slice(newline + 1);
  }
  return out.replace(/\n`{1,3}\s*$/, "\n").replace(/^`{1,3}\s*$/, "");
}
