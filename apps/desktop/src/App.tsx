import { useCallback, useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { engineHealth, getOnboardingState, type OnboardingState } from "./api";
import { checkForUpdate } from "./update";
import Onboarding from "./components/Onboarding";
import UpdatePrompt from "./components/UpdatePrompt";
import Workspace from "./components/Workspace";

// How often to poll R2 for a newer release. Also runs once on mount.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export default function App() {
  const [engineUp, setEngineUp] = useState<boolean | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);

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

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

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
        <h1>PromptConnext</h1>
        <p className="error">
          Local engine unreachable — it normally starts with the app. Check the logs
          and relaunch.
        </p>
      </main>
    );
  }

  // The update prompt overlays whichever screen is active, but only once the
  // app is past the engine gate so it doesn't fight the "Starting…"/error
  // states.
  const updatePrompt = update ? (
    <UpdatePrompt update={update} onDismiss={() => setUpdate(null)} />
  ) : null;

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
      <Workspace />
      {updatePrompt}
    </>
  );
}
