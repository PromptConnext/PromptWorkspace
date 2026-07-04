import { useState } from "react";
import { runConstitution } from "../api";
import SpecDoc from "./SpecDoc";

// One-time project principles (Spec Kit constitution, ADR 0009). Presented as
// optional setup under the 3S vision; it steers specify/plan/tasks. Uses the
// lightweight generator — no coding agent needed.
export default function ConstitutionSetup({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [principles, setPrinciples] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setOutput("");
    try {
      const res = await runConstitution(projectId, principles, (d) =>
        setOutput((p) => (p ?? "") + d),
      );
      setOutput(res.content);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="link constitution-toggle" onClick={() => setOpen(true)}>
        + Set project principles (optional) — shapes every spec &amp; plan
      </button>
    );
  }

  return (
    <div className="stage-panel constitution">
      <h3>Project principles (constitution)</h3>
      <p className="muted">
        Ground rules the whole project should honor — tech constraints, quality bars, non-negotiables.
        These steer every Scope, Spec, and task. Optional; leave blank for sensible defaults.
      </p>
      <textarea
        rows={4}
        value={principles}
        onChange={(e) => setPrinciples(e.target.value)}
        placeholder="e.g. Test-first. TypeScript strict. No secrets in the repo. Accessibility is required."
      />
      <div className="row">
        <button type="button" disabled={busy} onClick={generate}>
          {busy ? "Generating…" : "Generate constitution"}
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      {output && <SpecDoc content={output} streaming={busy} />}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
