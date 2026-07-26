"use client";

import { useCallback, useState } from "react";
import { CLOUD_API_URL } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import { parseSseLine, type SseParseState } from "@/lib/planner-sse";
import type { GenerateDoneEvent, GenerateErrorEvent, StageKind } from "@/lib/types";

type Status = "idle" | "generating" | "done" | "error";

export function useStageGeneration(projectId: string) {
  const { authHeaders } = useAuth();
  const [status, setStatus] = useState<Status>("idle");
  const [streamedText, setStreamedText] = useState("");
  const [result, setResult] = useState<GenerateDoneEvent | null>(null);
  const [error, setError] = useState<GenerateErrorEvent | null>(null);

  const generate = useCallback(
    async (stage: StageKind, userInput: string) => {
      setStatus("generating");
      setStreamedText("");
      setResult(null);
      setError(null);

      try {
        const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/generate/${stage}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ user_input: userInput }),
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          const detail = (body as { detail?: string }).detail;
          setStatus("error");
          setError({
            error: detail || `request failed (${res.status})`,
            ...(res.status === 429 ? { retryable: true } : {}),
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let state: SseParseState = null;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            state = parseSseLine(line, state);
            if (state?.event === "message" && state.fresh) {
              const delta = (state.data as { delta?: string }).delta;
              if (delta) setStreamedText((prev) => prev + delta);
            }
          }
        }

        if (state?.event === "done") {
          setResult(state.data as GenerateDoneEvent);
          setStatus("done");
        } else if (state?.event === "error") {
          setError(state.data as GenerateErrorEvent);
          setStatus("error");
        } else {
          setStatus("error");
          setError({ error: "stream ended with no result" });
        }
      } catch (err) {
        setStatus("error");
        setError({ error: err instanceof Error ? err.message : "network error", retryable: true });
      }
    },
    [projectId, authHeaders],
  );

  return { status, streamedText, result, error, generate };
}
