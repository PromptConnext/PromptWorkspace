import { useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { skipVersion } from "../update";

// The update notification. Rendered when checkForUpdate() surfaces a newer
// release. Three choices (ADR-less product decision, confirmed with the user):
//   - Update now → download + install + relaunch immediately.
//   - Skip this version → never prompt again for this exact version.
//   - Remind me later → dismiss; the next periodic check re-prompts.
export default function UpdatePrompt({
  update,
  onDismiss,
}: {
  update: Update;
  onDismiss: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installNow = async () => {
    setDownloading(true);
    setError(null);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setPct(total > 0 ? 0 : null);
            break;
          case "Progress":
            got += event.data.chunkLength;
            if (total > 0) setPct(Math.min(100, Math.round((got / total) * 100)));
            break;
          case "Finished":
            setPct(100);
            break;
        }
      });
      // Installed; restart into the new version. The Rust RunEvent::Exit
      // handler kills the engine sidecar on the way out, so this is a clean
      // shutdown before the relaunch.
      await relaunch();
    } catch (err) {
      setDownloading(false);
      setError((err as Error).message);
    }
  };

  const skip = () => {
    skipVersion(update.version);
    onDismiss();
  };

  return (
    <div className="update-overlay">
      <div className="update-dialog">
        <h3>Update available</h3>
        <p className="muted">
          Version <strong>{update.version}</strong> is ready to install
          {update.currentVersion ? ` (you have ${update.currentVersion})` : ""}.
        </p>
        {update.body && <p className="update-notes">{update.body}</p>}

        {downloading ? (
          <div className="update-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct ?? 100}%` }} />
            </div>
            <p className="muted">
              {pct === null ? "Downloading…" : pct < 100 ? `Downloading… ${pct}%` : "Installing…"}
            </p>
          </div>
        ) : (
          <div className="update-actions">
            <button type="button" className="active" onClick={installNow}>
              Update now
            </button>
            <button type="button" onClick={skip}>
              Skip this version
            </button>
            <button type="button" onClick={onDismiss}>
              Remind me later
            </button>
          </div>
        )}

        {error && <p className="error">Update failed: {error}</p>}
      </div>
    </div>
  );
}
