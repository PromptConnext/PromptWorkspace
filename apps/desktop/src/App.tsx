import { useCallback, useEffect, useState } from "react";
import { engineHealth, getOnboardingState, type OnboardingState } from "./api";
import Onboarding from "./components/Onboarding";
import Workspace from "./components/Workspace";

export default function App() {
  const [engineUp, setEngineUp] = useState<boolean | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);

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
  if (onboarding !== "satisfied") {
    return <Onboarding onDone={refresh} />;
  }
  return <Workspace />;
}
