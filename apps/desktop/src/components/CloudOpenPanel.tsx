import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

// First-open gate for a cloud project that has never been opened on this
// machine (plan: docs/superpowers/plans/2026-07-19-desktop-local-project-path.md).
// Shown instead of CloudConnect/ThreeS until the user picks a folder or
// explicitly accepts the default — never auto-created silently.
//
// `mode` distinguishes the two ways the engine can materialize the project
// (plan: cloud creates the repo at tech-review exit) — "clone" when the cloud
// project already has a repo_url (the engine clones it, seeded with AI
// context), "init" when it doesn't (a plain local-only project, `git init`).
// The underlying openCloudProject() call is unchanged either way — the engine
// decides init vs. clone from the roster row, this panel only adjusts copy.
export default function CloudOpenPanel({
  projectName,
  mode,
  repoUrl,
  busy,
  onChooseFolder,
  onUseDefault,
}: {
  projectName: string;
  mode: "init" | "clone";
  repoUrl?: string | null;
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
      {mode === "clone" ? (
        <p className="muted">
          This project&apos;s repository was created and seeded by PromptConnext Cloud. Choose a
          folder to clone <code>{repoUrl}</code> into, or use the default location.
        </p>
      ) : (
        <p className="muted">
          This project syncs from the cloud. Choose a folder for its files, or use the default
          location.
        </p>
      )}
      <div className="cloud-open-actions">
        <button type="button" disabled={busy || pickerBusy} onClick={chooseFolder}>
          {pickerBusy ? "Choosing…" : "Choose folder…"}
        </button>
        <button type="button" disabled={busy || pickerBusy} onClick={onUseDefault}>
          {busy ? (mode === "clone" ? "Cloning…" : "Opening…") : "Use default location"}
        </button>
      </div>
    </section>
  );
}

// Shown instead of CloudOpenPanel for a cloud project that has no local
// counterpart yet and hasn't reached repo_created — there is nothing to open
// or clone until the cloud finishes planning and (for tech_review) the Tech
// Lead creates the repository. No open action is offered; this is purely
// informational (plan: cloud creates the repo at tech-review exit).
export function ProjectNotReadyPanel({
  projectName,
  lifecycleStatus,
  onCheckAgain,
  checking,
}: {
  projectName: string;
  lifecycleStatus: string;
  onCheckAgain: () => void;
  checking: boolean;
}) {
  const explanation =
    lifecycleStatus === "tech_review"
      ? "The Tech Lead is reviewing this project's plan. Once the repository is created, you'll be able to open it here."
      : lifecycleStatus === "pending_tech_review"
        ? "This project is waiting for tech review before its repository is created."
        : "This project is still being planned in PromptConnext Cloud.";

  return (
    <section className="cloud-open-panel">
      <div className="import-head">
        <strong>&quot;{projectName}&quot; isn&apos;t ready to open yet</strong>
      </div>
      <p className="muted">{explanation}</p>
      {/* The status is read from the locally cached roster, which otherwise
          only re-pulls on window focus — useless while the user sits here
          watching this very panel. */}
      <div className="cloud-open-actions">
        <button type="button" disabled={checking} onClick={onCheckAgain}>
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
    </section>
  );
}
