"use client";

import { useState } from "react";
import type { WorkspaceFacts } from "@/lib/types";
import { useAskWorkspace } from "./useAskWorkspace";

export const EXAMPLE_QUESTIONS = [
  "Who is waiting on me?",
  "Which projects have no tech steward?",
  "What did agents close this week?",
];

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function factSentences(f: WorkspaceFacts): string[] {
  const out: string[] = [];
  const n = f.my_open_decisions.length;
  out.push(n ? `You have ${plural(n, "decision", "decisions")} waiting.` : "Nothing is waiting on you.");
  for (const p of f.projects_missing_hats) {
    out.push(`${p.name} has no ${p.hats.map((h) => h.replace(/_/g, " ")).join(" or ")}.`);
  }
  if (f.overdue.length) {
    for (const o of f.overdue) {
      out.push(`${o.name} has ${plural(o.count, "overdue decision", "overdue decisions")}.`);
    }
  } else {
    out.push("No decisions are overdue.");
  }
  for (const x of f.expired ?? []) {
    out.push(`${plural(x.count, "decision", "decisions")} expired without an answer in ${x.name}.`);
  }
  for (const [runtime, names] of Object.entries(f.by_runtime)) {
    out.push(`Projects on ${runtime}: ${names.join(", ")}.`);
  }
  out.push(`Agents closed ${plural(f.agent_closed_30d, "task", "tasks")} in the last 30 days.`);
  return out;
}

export function AskBox({ workspaceId }: { workspaceId: string }) {
  const { facts, answer, streaming, error, ask } = useAskWorkspace(workspaceId);
  const [question, setQuestion] = useState("");

  function submit(q: string) {
    const text = q.trim();
    if (!text || streaming) return;
    setQuestion(text);
    void ask(text);
  }

  return (
    <section className="mb-8 rounded-xl border border-slate-200 bg-white p-4">
      <label htmlFor="ask-workspace" className="mb-2 block text-sm font-medium text-slate-700">
        Ask about this workspace
      </label>
      <input
        id="ask-workspace"
        type="text"
        value={question}
        maxLength={500}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(question);
        }}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {EXAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => submit(q)}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-300"
          >
            {q}
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {answer ? (
        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">{answer}</p>
      ) : (
        !streaming &&
        facts && (
          <ul className="mt-3 space-y-1 text-sm text-slate-800">
            {factSentences(facts).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
