// Server-sent-event frame reader.
//
// Distinct from lib/planner-sse.ts, which parses one line at a time and has no
// frame boundary. That works for app/api/generation.py, whose only named events
// (done, error) are terminal, but corrupts app/api/assistant.py's stream, which
// emits `event: facts` mid-stream and then continues with bare data: deltas.
// Framing on the blank line is what makes the event name reset correctly.

export type SseFrame = { event: string; data: unknown };

export function parseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  // A trailing CR may be the first half of a CRLF split across two network
  // chunks. Normalising it now would invent a line break, so hold it back.
  let pending = "";
  let text = buffer;
  if (text.endsWith("\r")) {
    pending = "\r";
    text = text.slice(0, -1);
  }

  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  // The final block is either empty (buffer ended on a frame boundary) or a
  // partial frame still arriving — either way it is not ready to emit.
  const trailing = blocks.pop() ?? "";

  const frames: SseFrame[] = [];
  for (const block of blocks) {
    const frame = parseBlock(block);
    if (frame) frames.push(frame);
  }

  return { frames, rest: trailing + pending };
}

function parseBlock(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // The SSE spec strips exactly one leading space, not all whitespace.
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (data.length === 0) return null;

  try {
    return { event, data: JSON.parse(data.join("\\n")) };
  } catch {
    // A malformed payload costs one frame, not the rest of the stream.
    return null;
  }
}
