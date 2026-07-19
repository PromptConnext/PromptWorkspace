import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

// First-open gate for a cloud project that has never been opened on this
// machine (plan: docs/superpowers/plans/2026-07-19-desktop-local-project-path.md).
// Shown instead of CloudConnect/ThreeS until the user picks a folder or
// explicitly accepts the default — never auto-created silently.
export default function CloudOpenPanel({
  projectName,
  busy,
  onChooseFolder,
  onUseDefault,
}: {
  projectName: string;
  busy: boolean;
  onChooseFolder: (path: string) => void;
  onUseDefault: () => void;
}) {
  const [pickerBusy, setPickerBusy] = useState(false);

  const chooseFolder = async () => {
    setPickerBusy(true);
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: `Choose a folder for "${projectName}"`,
      });
      if (typeof dir === "string") onChooseFolder(dir);
    } finally {
      setPickerBusy(false);
    }
  };

  return (
    <section className="cloud-open-panel">
      <div className="import-head">
        <strong>Where should &quot;{projectName}&quot; live on this computer?</strong>
      </div>
      <p className="muted">
        This project syncs from the cloud. Choose a folder for its files, or use the default
        location.
      </p>
      <div className="cloud-open-actions">
        <button type="button" disabled={busy || pickerBusy} onClick={chooseFolder}>
          {pickerBusy ? "Choosing…" : "Choose folder…"}
        </button>
        <button type="button" disabled={busy || pickerBusy} onClick={onUseDefault}>
          {busy ? "Opening…" : "Use default location"}
        </button>
      </div>
    </section>
  );
}
