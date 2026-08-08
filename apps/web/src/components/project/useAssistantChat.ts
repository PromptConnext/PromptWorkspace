"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { CLOUD_API_URL } from "@/lib/config";
import { parseFrames } from "@/lib/sse";
import type { Citation, LineageFacts } from "@/lib/types";

export type AssistantErrorKind = "no_model" | "embed_mismatch" | "budget" | "cut_off" | "other";

export interface AssistantError {
  kind: AssistantErrorKind;
  message: string;
}

export interface Turn {
  id: number;
  question: string;
  facts: LineageFacts | null;
  answer: string;
  citations: Citation[];
  status: "streaming" | "done" | "error";
  error: AssistantError | null;
}

// The 400 and 429 details are bare identifiers, but the 409's is a full
// sentence beginning "embed_model_mismatch:" (app/api/assistant.py:243-252).
// Matching by equality would drop it into the generic branch and lose the
// reindex affordance, which is the only reason that branch exists.
function classify(status: number, detail: string): AssistantError {
  if (detail.startsWith("model_connection_not_configured")) {
    return { kind: "no_model", message: "No model is connected for this workspace." };
  }
  if (detail.startsWith("embed_model_mismatch")) {
    return {
      kind: "embed_mismatch",
      message: "This project was indexed with a different embedding model.",
    };
  }
  if (detail.startsWith("daily_token_budget_exceeded")) {
    return { kind: "budget", message: "Daily assistant budget reached. Try again tomorrow." };
  }
  return { kind: "other", message: detail || `Request failed (${status}).` };
}

export function useAssistantChat(projectId: string) {
  const { authHeaders } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(0);
  const abort = useRef<AbortController | null>(null);

  // Closing the panel or navigating away stops the read. The server keeps
  // generating and still bills for it — this only stops us listening.
  useEffect(() => () => abort.current?.abort(), []);

  const patch = useCallback((id: number, change: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }, []);

  const run = useCallback(
    async (turnId: number, question: string) => {
      setBusy(true);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      try {
        const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/assistant/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ question }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          const detail = (body as { detail?: string }).detail ?? "";
          patch(turnId, { status: "error", error: classify(res.status, detail) });
          return;
        }

        const reader = res.body.getReader();
        // stream: true is what makes a multi-byte character split across two
        // network chunks decode correctly rather than as replacement chars.
        const decoder = new TextDecoder();
        let buf = "";
        let answer = "";
        let sawCitations = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { frames, rest } = parseFrames(buf);
          buf = rest;

          for (const frame of frames) {
            if (frame.event === "facts") {
              patch(turnId, { facts: frame.data as LineageFacts });
            } else if (frame.event === "message") {
              const delta = (frame.data as { delta?: string }).delta;
              if (delta) {
                answer += delta;
                patch(turnId, { answer });
              }
            } else if (frame.event === "citations") {
              sawCitations = true;
              patch(turnId, {
                citations: (frame.data as { citations: Citation[] }).citations ?? [],
              });
            }
            // Unknown event kinds are ignored so a newer server degrades this
            // tab to prose instead of breaking it.
          }
        }

        if (sawCitations) {
          patch(turnId, { status: "done" });
        } else {
          // The citations frame is the stream's only completion marker. Its
          // absence means the generator died mid-body — keep what arrived.
          patch(turnId, {
            status: "error",
            error: { kind: "cut_off", message: "The answer was cut off." },
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        patch(turnId, {
          status: "error",
          error: { kind: "other", message: (err as Error).message || "Network error." },
        });
      } finally {
        setBusy(false);
      }
    },
    [projectId, authHeaders, patch],
  );

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;
      const id = nextId.current++;
      setTurns((prev) => [
        ...prev,
        {
          id,
          question: trimmed,
          facts: null,
          answer: "",
          citations: [],
          status: "streaming",
          error: null,
        },
      ]);
      await run(id, trimmed);
    },
    [run],
  );

  const retry = useCallback(
    async (turnId: number) => {
      let question = "";
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turnId) return t;
          question = t.question;
          return { ...t, facts: null, answer: "", citations: [], status: "streaming", error: null };
        }),
      );
      if (question) await run(turnId, question);
    },
    [run],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    setTurns([]);
  }, []);

  return { turns, busy, ask, retry, reset };
}
