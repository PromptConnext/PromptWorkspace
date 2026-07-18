import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { redeemBrowserLogin, startBrowserLogin } from "../api";

// Identity gate (ADR 0015 state 1). Reuses the ADR 0014 browser handoff
// unchanged — start a login, open the hosted sign-in page, and redeem the
// promptconnext:// callback the Rust shell forwards as `auth-callback`. On a
// successful redeem it calls onSignedIn, which re-drives App's gate.
export default function AuthGate({ onSignedIn }: { onSignedIn: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<{ url: string }>("auth-callback", async (event) => {
      try {
        const url = new URL(event.payload.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return;
        await redeemBrowserLogin(code, state);
        setWaiting(false);
        onSignedIn();
      } catch (err) {
        setWaiting(false);
        setError((err as Error).message);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginBrowserLogin = async () => {
    setError(null);
    setWaiting(true);
    try {
      const { url } = await startBrowserLogin();
      await openUrl(url);
    } catch (err) {
      setWaiting(false);
      setError((err as Error).message);
    }
  };

  return (
    <main className="gate">
      <h1>Sign in to PromptConnext</h1>
      <p>
        Your workspaces and projects live in PromptConnext Cloud. Sign in with
        your browser to continue — your code, model keys, and compute stay on
        this machine.
      </p>
      <button type="button" disabled={waiting} onClick={beginBrowserLogin}>
        {waiting ? "Waiting for browser…" : "Sign in with browser"}
      </button>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
