import ConnectForm from "./ConnectForm";

// The BYOM cold-start gate: blocks the workspace until one model connection
// passes a live health check (architecture §3.4).
export default function Onboarding({ onDone }: { onDone: () => void }) {
  return (
    <main className="onboarding">
      <h1>Welcome to PromptZone</h1>
      <p>
        PromptZone orchestrates the AI models <em>you</em> bring — it ships none of
        its own. Connect one model to get started. No AI subscription? Pick{" "}
        <strong>Local Ollama</strong>: free, private, nothing to sign up for.
      </p>
      <p className="hint">
        Your key is verified with a live call before it's accepted, and it is
        stored only in the macOS keychain on this machine — never in the cloud.
      </p>
      <ConnectForm role="plan" onConnected={onDone} />
    </main>
  );
}
