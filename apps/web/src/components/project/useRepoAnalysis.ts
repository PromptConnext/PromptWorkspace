"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOUD_API_URL } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import { parseFrames } from "@/lib/sse";
import type { GenerateErrorEvent, RepoAnalysisDoneEvent, RepoAnalysisOut } from "@/lib/types";

type Status = "idle" | "analyzing" | "done" | "error";

// Streams POST /projects/{id}/repo-analysis (plan 0027 M2). A sibling of
// useStageGeneration rather than a generalisation of it: this stream emits a
// named `event: snapshot` *before* its deltas, and lib/planner-sse.ts's
// line-at-a-time parser only knows terminal named events — it would read the
// snapshot as a delta with no text and drop it. lib/sse.ts's frame reader,
// which the assistant stream already needed for the same reason, handles it.
//
// `onAnalysis` receives every server view of the stored analysis the stream
// carries — the snapshot the moment the repository has been read, the final
// analysis at `done` — so the caller's copy (which gates the Plan and Tasks
// tabs) moves with the stream instead of waiting for a refetch.
export function useRepoAnalysis(
  projectId: string,
  onAnalysis: (analysis: RepoAnalysisOut) => void,
) {
  const { authHeaders } = useAuth();
  const [status, setStatus] = useState<Status>("idle");
  const [streamedText, setStreamedText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<GenerateErrorEvent | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Leaving the page stops the read. The server keeps generating and still
  // stores the baseline, which the next GET will show.
  useEffect(() => () => abort.current?.abort(), []);

  const analyze = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setStatus("analyzing");
    setStreamedText("");
    setTruncated(false);
    setError(null);

    try {
      const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/repo-analysis`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        signal: controller.signal,
      });

      // Every refusal — role, project state, GitHub access, model, budget —
      // arrives here as a plain JSON `detail`, before the stream opens.
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        const detail = (body as { detail?: string }).detail;
        setStatus("error");
        setError({
          error: detail || `request failed (${res.status})`,
          ...(res.status === 429 || res.status === 502 ? { retryable: true } : {}),
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let terminal: { event: "done" | "error"; data: unknown } | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { frames, rest } = parseFrames(buf);
        buf = rest;
        for (const frame of frames) {
          if (frame.event === "snapshot") {
            onAnalysis(frame.data as RepoAnalysisOut);
          } else if (frame.event === "message") {
            const delta = (frame.data as { delta?: string }).delta;
            if (delta) setStreamedText((prev) => prev + delta);
          } else if (frame.event === "done" || frame.event === "error") {
            terminal = { event: frame.event, data: frame.data };
          }
        }
      }
      if (terminal?.event === "done") {
        const { truncated: cut, ...analysis } = terminal.data as RepoAnalysisDoneEvent;
        onAnalysis(analysis);
        setTruncated(Boolean(cut));
        setStatus("done");
      } else if (terminal?.event === "error") {
        setError(terminal.data as GenerateErrorEvent);
        setStatus("error");
      } else {
        setError({ error: "stream ended with no result", retryable: true });
        setStatus("error");
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStatus("error");
      setError({ error: err instanceof Error ? err.message : "network error", retryable: true });
    }
  }, [projectId, authHeaders, onAnalysis]);

  return { status, streamedText, truncated, error, analyze };
}
