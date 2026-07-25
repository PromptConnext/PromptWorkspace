import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { connectModel, getRecommendations, type Recommendation } from "../api";

const CUSTOM: Recommendation = {
  provider: "",
  label: "Custom / other",
  endpoint: "",
  model: "",
  needsKey: true,
  role: "plan",
  cost: "Any OpenAI-compatible endpoint",
  hint: "vLLM, LM Studio, a self-hosted gateway, or any provider with an OpenAI-compatible API.",
};

// Guided model connection (ADR 0006/0007): pick a provider → see cost + where
// to get a key → paste → verify. The `role` prop is the context default
// (Scope/Spec onboarding = plan; Skill stage = code); each card can suggest its
// own best-fit role.
export default function ConnectForm({
  role,
  onConnected,
}: {
  role: "plan" | "code";
  onConnected: () => void;
}) {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [picked, setPicked] = useState<Recommendation | null>(null);
  const [provider, setProvider] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connRole, setConnRole] = useState<"plan" | "code">(role);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRecommendations().then((r) => setRecs(r.recommendations)).catch(() => {});
  }, []);

  const pick = (rec: Recommendation) => {
    setPicked(rec);
    setProvider(rec.provider);
    setEndpoint(rec.endpoint);
    setModel(rec.model);
    setConnRole((rec.role as "plan" | "code") || role);
    setApiKey("");
    setError(null);
    setAdvanced(rec.provider === ""); // custom → show endpoint/model straight away
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await connectModel({
        role: connRole,
        provider: provider || "custom",
        endpoint,
        model,
        ...(apiKey ? { apiKey } : {}),
      });
      onConnected();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!picked) {
    const free = recs.filter((rec) => !rec.needsKey);
    const keyed = [...recs.filter((rec) => rec.needsKey), CUSTOM];
    const card = (rec: Recommendation) => (
      <button key={rec.label} type="button" className="provider-card" onClick={() => pick(rec)}>
        <span className="pc-head">
          <span className="pc-label">{rec.label}</span>
          <span className="pc-tag">{rec.role === "code" ? "coding" : "planning"}</span>
        </span>
        {rec.cost && <span className="pc-cost">{rec.cost}</span>}
        {rec.hint && <span className="pc-hint">{rec.hint}</span>}
      </button>
    );
    return (
      <div className="provider-picker">
        {free.length > 0 && (
          <div className="provider-group">
            <h3>Free · runs on your machine</h3>
            {free.map(card)}
          </div>
        )}
        <div className="provider-group">
          <h3>Bring your own key</h3>
          {keyed.map(card)}
        </div>
      </div>
    );
  }

  const needsKey = picked.needsKey;
  const canSubmit = !busy && Boolean(model) && Boolean(endpoint);

  return (
    <div className="connect-detail">
      <button type="button" className="link" onClick={() => setPicked(null)}>
        ← choose a different provider
      </button>
      <h4>{picked.label}</h4>

      {picked.steps && (
        <ol className="steps">
          {picked.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}

      {needsKey && picked.getKeyUrl && (
        <p className="muted">
          Get a key at:{" "}
          <a
            className="url"
            href={picked.getKeyUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              openUrl(picked.getKeyUrl!);
            }}
          >
            {picked.getKeyUrl}
          </a>
        </p>
      )}

      {needsKey ? (
        <label>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="paste your key"
          />
        </label>
      ) : (
        <p className="muted">No key needed — this runs locally on your machine.</p>
      )}

      <label>
        Use this model for
        <select value={connRole} onChange={(e) => setConnRole(e.target.value as "plan" | "code")}>
          <option value="plan">Planning — Scope &amp; Spec</option>
          <option value="code">Coding — implementation &amp; the Run button</option>
        </select>
      </label>

      <button type="button" className="link" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "Hide" : "Advanced"} — endpoint &amp; model id
      </button>
      {advanced && (
        <>
          <label>
            Endpoint (base URL)
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          </label>
          <label>
            Model id
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        </>
      )}

      <p className="muted confirm">
        Will connect <strong>{model || "…"}</strong> ({provider || "custom"}) as the{" "}
        <strong>{connRole}</strong> model.
      </p>
      <button type="button" disabled={!canSubmit} onClick={submit}>
        {busy ? "Verifying with a live call…" : "Connect & verify"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
