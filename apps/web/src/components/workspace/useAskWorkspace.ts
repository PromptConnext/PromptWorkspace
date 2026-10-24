"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { CLOUD_API_URL } from "@/lib/config";
import { parseFrames } from "@/lib/sse";
import type { WorkspaceFacts } from "@/lib/types";

export interface AskState {
  facts: WorkspaceFacts | null;
  answer: string;
  streaming: boolean;
  error: string | null;
}

const IDLE: AskState = { facts: null, answer: "", streaming: false, error: null };

export function useAskWorkspace(workspaceId: string) {
  const { authHeaders } = useAuth();
  const [state, setState] = useState<AskState>(IDLE);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState({ ...IDLE, streaming: true });
      try {
        const res = await fetch(`${CLOUD_API_URL}/workspaces/${workspaceId}/ask`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ question }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          setState({ ...IDLE, error: "Could not ask the workspace. Try again." });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let answer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { frames, rest } = parseFrames(buf);
          buf = rest;
          for (const frame of frames) {
            if (frame.event === "facts") {
              setState((s) => ({ ...s, facts: frame.data as WorkspaceFacts }));
            } else if (frame.event === "message") {
              const delta = (frame.data as { delta?: string }).delta;
              if (delta) {
                answer += delta;
                setState((s) => ({ ...s, answer }));
              }
            }
          }
        }
        setState((s) => ({ ...s, streaming: false }));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          streaming: false,
          error: (err as Error).message || "Network error.",
        }));
      }
    },
    [workspaceId, authHeaders],
  );

  return { ...state, ask };
}
