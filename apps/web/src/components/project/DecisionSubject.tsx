import { useMemo } from "react";
import { type DiffLine, lineDiff } from "@/lib/lineDiff";
import type { Decision } from "@/lib/types";

const LINE_STYLE: Record<DiffLine["kind"], string> = {
  same: "text-slate-700",
  add: "bg-emerald-50 text-emerald-900",
  del: "bg-rose-50 text-rose-900 line-through decoration-rose-300",
};
const MARK: Record<DiffLine["kind"], string> = { same: " ", add: "+", del: "-" };

/** What a decision asks the approver to sign: the document as it was when
 * requested, as a diff against the newest earlier approved version when there
 * is one. The text comes from repositories and users, so every line is a text
 * node in a `<pre>`-style block, never parsed as markdown or HTML. */
export function DecisionSubject({
  decision,
  previous,
}: {
  decision: Decision;
  /** The newest earlier approved decision of the same kind, if any. */
  previous: Decision | null;
}) {
  const content = decision.subject_content;
  const before = previous?.subject_content ?? null;
  const diff = useMemo(
    () => (content !== null && before !== null ? lineDiff(before, content) : null),
    [content, before],
  );

  if (content === null) {
    return (
      <p className="mt-2 text-xs text-slate-500">No saved copy of the document for this request</p>
    );
  }

  const unchanged = diff !== null && diff.every((l) => l.kind === "same");
  const lines: DiffLine[] = diff ?? content.split("\n").map((text) => ({ kind: "same", text }));
  const caption =
    diff === null
      ? previous === null
        ? "Full document (nothing was approved before)"
        : "Full document (the last approval has no saved copy to compare)"
      : unchanged
        ? "No changes since the last approval"
        : "Changes since the last approval";

  return (
    <details open={decision.status === "open"} className="mt-2 rounded border border-slate-200">
      <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-slate-600">
        {caption}
      </summary>
      <div className="max-h-96 overflow-auto border-t border-slate-100 p-2 font-mono text-xs">
        {!unchanged &&
          lines.map((line, i) => (
            <div
              // The document has no stable line ids; the position is the identity.
              key={i}
              data-diff={line.kind}
              className={`whitespace-pre-wrap break-words ${LINE_STYLE[line.kind]}`}
            >
              {diff !== null && <span aria-hidden="true">{MARK[line.kind]} </span>}
              {line.text}
            </div>
          ))}
      </div>
    </details>
  );
}
