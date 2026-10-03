import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { engineHealth, getOnboardingState, type OnboardingState } from "./api";
import { membershipGateEnabled, resolveGate, type CloudGate } from "./cloudGate";
import { checkForUpdate } from "./update";
import Onboarding from "./components/Onboarding";
import AuthGate from "./components/AuthGate";
import NoWorkspace from "./components/NoWorkspace";
import UpdatePrompt from "./components/UpdatePrompt";
import Workspace from "./components/Workspace";

// How often to poll R2 for a newer release. Also runs once on mount.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export default function App() {
  const [engineUp, setEngineUp] = useState<boolean | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  // Identity + membership gate (ADR 0015). With the feature flag off it starts
  // synchronously "disabled" so the app renders exactly as before — no flash,
  // no roster pulls. Only when enabled does it start null (still resolving).
  const [gate, setGate] = useState<CloudGate | null>(
    membershipGateEnabled ? null : { kind: "disabled" },
  );
  const [update, setUpdate] = useState<Update | null>(null);
  // Crash-retry UI (WP7c): recent engine stdout/stderr lines shown alongside
  // the "unreachable" error, plus a Retry action that respawns the sidecar
  // in place instead of requiring a full app relaunch.
  const [engineLog, setEngineLog] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async () => {
    const up = await engineHealth();
    setEngineUp(up);
    if (up) {
      try {
        const { state } = await getOnboardingState();
        setOnboarding(state);
      } catch {
        setOnboarding(null);
      }
    }
  }, []);

  // Re-drive the identity + membership gate. Runs once the engine is up, on
  // window focus (so a live membership revocation or sign-out transitions the
  // app — ADR 0015 states 6/7), and on demand from the gate screens. A cached,
  // refresh-extended session still counts as signed in, so this never becomes a
  // hard live-network check on launch.
  const recheckGate = useCallback(async () => {
    try {
      setGate(await resolveGate());
    } catch {
      // Never lock the user out on an unexpected error — fall open to the
      // existing (ungated) flow.
      setGate({ kind: "disabled" });
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  // Once the engine is confirmed down, pull its recent log tail so the error
  // screen can show *why* — best-effort, and a no-op outside Tauri.
  useEffect(() => {
    if (engineUp !== false) return;
    invoke<string[]>("engine_log_tail")
      .then(setEngineLog)
      .catch(() => {});
  }, [engineUp]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await invoke("restart_engine");
    } catch {
      // Surfaced via the still-failing health poll below.
    } finally {
      await refresh();
      setRetrying(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!membershipGateEnabled) return;
    if (engineUp) recheckGate();
  }, [engineUp, recheckGate]);

  useEffect(() => {
    if (!membershipGateEnabled) return;
    const onFocus = () => recheckGate();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [recheckGate]);

  // Auto-update: check on launch and periodically. checkForUpdate() is a no-op
  // outside Tauri and swallows the skipped version, so we only get a non-null
  // Update worth prompting for. Failures (offline, R2 unreachable) are silent —
  // the next tick retries.
  useEffect(() => {
    const run = () =>
      checkForUpdate()
        .then((u) => {
          if (u) setUpdate(u);
        })
        .catch(() => {});
    run();
    const t = setInterval(run, UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  if (engineUp === null) return <main className="center">Starting…</main>;
  if (!engineUp) {
    return (
      <main className="center">
        <h1>PromptWorkspace</h1>
        <p className="error">
          Local engine unreachable — it normally starts with the app. Check the logs
          and relaunch.
        </p>
        <button onClick={handleRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry"}
        </button>
        {engineLog.length > 0 && (
          <details>
            <summary>Recent engine log</summary>
            <pre>{engineLog.join("\n")}</pre>
          </details>
        )}
      </main>
    );
  }

  // The update prompt overlays whichever screen is active, but only once the
  // app is past the engine gate so it doesn't fight the "Starting…"/error
  // states.
  const updatePrompt = update ? (
    <UpdatePrompt update={update} onDismiss={() => setUpdate(null)} />
  ) : null;

  // Identity + membership gates sit AHEAD of model onboarding (ADR 0015):
  // engine → auth → membership → onboarding → Workspace. `gate === null` means
  // it is still resolving; show a light placeholder rather than briefly
  // flashing the onboarding/workspace screen.
  if (gate === null) return <main className="center">Loading…</main>;
  if (gate.kind === "auth") {
    return (
      <>
        <AuthGate onSignedIn={recheckGate} />
        {updatePrompt}
      </>
    );
  }
  if (gate.kind === "no-workspace") {
    return (
      <>
        <NoWorkspace onChanged={recheckGate} />
        {updatePrompt}
      </>
    );
  }

  if (onboarding !== "satisfied") {
    return (
      <>
        <Onboarding onDone={refresh} />
        {updatePrompt}
      </>
    );
  }
  return (
    <>
      <Workspace onGateRecheck={recheckGate} />
      {updatePrompt}
    </>
  );
}
