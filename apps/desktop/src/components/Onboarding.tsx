import ConnectForm from "./ConnectForm";

// The BYOM cold-start gate: blocks the workspace until one model connection
// passes a live health check (architecture §3.4).
export default function Onboarding({ onDone }: { onDone: () => void }) {
  return (
    <main className="onboarding">
      <h1>Welcome to PromptConnext</h1>
      <p>
        PromptConnext orchestrates the AI models <em>you</em> bring — it ships none of
        its own. Connect one model to get started. No AI subscription? Pick{" "}
        <strong>Local Ollama</strong>: free, private, nothing to sign up for.
      </p>
      <p className="hint">
        Your key is verified with a live call before it's accepted, and it is
        stored only in the macOS keychain on this machine — never in the cloud.
      </p>
      <p className="hint">
        Already pay for Claude, Codex, or Gemini? This step connects the{" "}
        <strong>planning</strong> model for Scope &amp; Spec. Once you're in, the{" "}
        <strong>Coding agent</strong> picker on a project detects Claude Code, Codex
        CLI, or Gemini CLI already installed and signed in on this machine — no key
        needed there, it runs on your existing subscription.
      </p>
      <ConnectForm role="plan" onConnected={onDone} />
    </main>
  );
}
