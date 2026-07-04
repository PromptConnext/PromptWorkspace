import { useState } from "react";

// Interactive Q&A for [NEEDS CLARIFICATION] markers (business surface): rather
// than telling the reviewer to retype answers into a free-text box, ask each
// question directly, collect answers inline, and hand them back as structured
// feedback that regenerates the spec/plan with the markers resolved.
export default function Clarifications({
  questions,
  busy,
  onAnswer,
}: {
  questions: string[];
  busy: boolean;
  onAnswer: (feedback: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const answeredCount = questions.filter((_, i) => answers[i]?.trim()).length;

  const submit = () => {
    const lines = questions
      .map((q, i) => ({ q, a: answers[i]?.trim() }))
      .filter((x) => x.a)
      .map((x) => `- Q: ${x.q}\n  A: ${x.a}`);
    if (lines.length === 0) return;
    const feedback = [
      "The reviewer answered your open questions. Incorporate these answers and",
      "remove the corresponding [NEEDS CLARIFICATION] markers:",
      "",
      ...lines,
    ].join("\n");
    onAnswer(feedback);
  };

  return (
    <div className="clarify-panel">
      <h4>A few questions before we continue ({questions.length})</h4>
      <p className="muted">
        The AI wasn't sure about these. Answer what you can and regenerate — anything you
        skip stays an open question you can decide later.
      </p>
      <div className="clarify-qa">
        {questions.map((q, i) => (
          <label key={i} className="clarify-item">
            <span className="clarify-q">{q}</span>
            <input
              value={answers[i] ?? ""}
              disabled={busy}
              placeholder="Your answer…"
              onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
        ))}
      </div>
      <button type="button" disabled={busy || answeredCount === 0} onClick={submit}>
        {busy
          ? "Updating…"
          : `Answer ${answeredCount} of ${questions.length} & regenerate`}
      </button>
    </div>
  );
}
