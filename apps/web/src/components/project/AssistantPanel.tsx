"use client";

// Project-scoped RAG assistant (ADR 0011). Answers are ephemeral: they live
// here for the session and are cleared on close. Nothing is posted to the
// discussion thread — an assistant answer stored as a Discussion row would be
// embedded back into the project's own corpus by app/rag/queue.py.
//
// Every request is single-turn: ChatRequest is {question} with no history
// field (app/models/schemas.py:626), so the transcript below is display state
// only and pronoun follow-ups will be answered without prior context.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getStageDocument, listDocuments } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useNodeLabels } from "@/lib/node-labels";
import type { ProjectGraph, StageKind } from "@/lib/types";
import { AssistantFactCard } from "./AssistantFactCard";
import { CitationList } from "./CitationList";
import { useAssistantChat, type AssistantError, type Turn } from "./useAssistantChat";

const STAGES: StageKind[] = ["constitution", "specify", "plan", "tasks"];

function ErrorBlock({
  error,
  workspaceId,
  projectId,
  onRetry,
}: {
  error: AssistantError;
  workspaceId: string;
  projectId: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
      <p>{error.message}</p>
      {error.kind === "no_model" && (
        <Link href={`/w/${workspaceId}/settings`} className="mt-1 inline-block underline">
          Workspace settings
        </Link>
      )}
      {error.kind === "embed_mismatch" && (
        <Link
          href={`/w/${workspaceId}/p/${projectId}/settings#assistant-index`}
          className="mt-1 inline-block underline"
        >
          Reindex this project
        </Link>
      )}
      {/* Retry only where retrying can plausibly change the outcome. A missing
          model, a mismatched index and an exhausted budget are all unchanged
          by asking again. */}
      {(error.kind === "other" || error.kind === "cut_off") && (
        <button type="button" onClick={onRetry} className="mt-1 block underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function AssistantPanel({
  open,
  onClose,
  graph,
  workspaceId,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
}) {
  const { authHeaders } = useAuth();
  const labels = useNodeLabels(graph);
  const { turns, busy, ask, retry, reset } = useAssistantChat(projectId);
  const [question, setQuestion] = useState("");
  const [documentTitles, setDocumentTitles] = useState<Map<string, string>>(new Map());
  const [stageNames, setStageNames] = useState<Map<string, string>>(new Map());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const resolved = useRef(false);
  // The element focus should return to on close — captured at the moment the
  // panel opens, which is whatever the caller's trigger button was (it still
  // has focus at that point; nothing has moved it yet).
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      inputRef.current?.focus();
    } else if (previousFocus.current) {
      previousFocus.current.focus();
      previousFocus.current = null;
    }
  }, [open]);

  // Neither documents nor stage documents are ProjectGraph members, so their
  // titles need their own fetches. Fired once per panel session, lazily, the
  // first time a citation actually needs them — not on open. `close()` below
  // resets `resolved` so the next session re-fetches instead of trusting a
  // cache that may now be stale (the Planner tab can rename stage documents
  // or upload new ones while the panel sits open).
  const needsLookup = turns.some((t) =>
    t.citations.some((c) => c.node_type === "documents" || c.node_type === "stage_documents"),
  );

  useEffect(() => {
    if (!needsLookup || resolved.current) return;
    resolved.current = true;
    let cancelled = false;

    listDocuments(projectId, authHeaders())
      .then((docs) => {
        if (!cancelled) setDocumentTitles(new Map(docs.map((d) => [d.id, d.title])));
      })
      .catch(() => {
        // A failed lookup costs the chip its title, not the answer.
      });

    Promise.all(
      STAGES.map((stage) =>
        getStageDocument(projectId, stage, authHeaders())
          .then((doc) => [doc.id, stage] as const)
          .catch(() => [null, stage] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const [id, stage] of pairs) if (id) map.set(id, stage);
      setStageNames(map);
    });

    return () => {
      cancelled = true;
    };
  }, [needsLookup, projectId, authHeaders]);

  // The only path that clears the transcript, aborts an in-flight stream
  // (via reset()) and re-arms the label lookup for next time. Both the Close
  // button and Escape must go through this — calling onClose() directly
  // leaves a stream running and stale state behind, since DiscussionThread
  // never unmounts this component (it only toggles `open`), so the
  // unmount-abort effect inside useAssistantChat never gets a chance to fire.
  const close = useCallback(() => {
    reset();
    resolved.current = false;
    setDocumentTitles(new Map());
    setStageNames(new Map());
    onClose();
  }, [reset, onClose]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = question;
    setQuestion("");
    await ask(q);
  }

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Project assistant"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-slate-200 bg-white shadow-xl sm:w-[400px]"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Ask about this project</h2>
        <button type="button" onClick={close} className="text-sm text-slate-500 hover:text-slate-900">
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {turns.length === 0 && (
          <p className="text-sm text-slate-500">
            Answers are grounded in this project&apos;s synced requirements, specs, tasks and
            planning documents.
          </p>
        )}

        <ul className="flex flex-col gap-4">
          {turns.map((turn: Turn) => (
            <li key={turn.id} className="flex flex-col gap-2">
              <p className="text-sm font-medium text-slate-900">{turn.question}</p>
              {turn.facts && <AssistantFactCard facts={turn.facts} />}
              {turn.answer && (
                <p className="whitespace-pre-wrap text-sm text-slate-700">{turn.answer}</p>
              )}
              {turn.error && (
                <ErrorBlock
                  error={turn.error}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  onRetry={() => retry(turn.id)}
                />
              )}
              <CitationList
                citations={turn.citations}
                labels={labels}
                documentTitles={documentTitles}
                stageNames={stageNames}
              />
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={submit} className="border-t border-slate-200 p-3">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          disabled={busy}
          placeholder="Ask a self-contained question…"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Asking…" : "Send"}
        </button>
      </form>
    </aside>
  );
}
