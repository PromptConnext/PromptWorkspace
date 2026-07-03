import { useEffect, useState } from "react";
import {
  connectModel,
  getRecommendations,
  type Recommendation,
} from "../api";

export default function ConnectForm({
  role,
  onConnected,
}: {
  role: "plan" | "code";
  onConnected: () => void;
}) {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [provider, setProvider] = useState("ollama");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRecommendations().then((r) => setRecs(r.recommendations)).catch(() => {});
  }, []);

  const applyRec = (rec: Recommendation) => {
    setProvider(rec.provider);
    setEndpoint(rec.endpoint);
    setModel(rec.model);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await connectModel({
        role,
        provider,
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

  return (
    <div className="connect-form">
      <div className="rec-row">
        {recs.map((rec) => (
          <button key={rec.label} type="button" onClick={() => applyRec(rec)}>
            {rec.label}
          </button>
        ))}
      </div>
      <label>
        Provider
        <input value={provider} onChange={(e) => setProvider(e.target.value)} />
      </label>
      <label>
        Endpoint (base URL)
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
      </label>
      <label>
        Model
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="e.g. qwen3:8b"
        />
      </label>
      <label>
        API key (leave empty for local models)
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <button type="button" disabled={busy || !model} onClick={submit}>
        {busy ? "Verifying with a live call…" : "Connect & verify"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
