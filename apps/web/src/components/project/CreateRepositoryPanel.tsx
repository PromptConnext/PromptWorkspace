// apps/web/src/components/project/CreateRepositoryPanel.tsx
"use client";

import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { createRepository, getSeedPreview } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Project, SeedPreview } from "@/lib/types";

// Mirrors apps/engine/src/routes/projects.ts's slug derivation so the
// prefilled name matches what a desktop-side project creation would produce.
function slugify(name: string): string {
  return name.trim().replace(/[^\w-]+/g, "-").toLowerCase();
}

// Maps apps/cloud/app/api/sync.py's create-repository `detail` codes to
// sentences a business/tech-lead user can act on.
const DETAIL_MESSAGES: Record<string, string> = {
  // Plan 0029 delivery gates (on when the server sets REQUIRE_PLAN_APPROVAL).
  constitution_required:
    "Write the project rules (the Constitution step in the Planner) before creating the repository.",
  tasks_required: "Generate the tasks in the Planner before creating the repository.",
  plan_approval_required:
    "The delivery plan needs approval first. Request it on the Delivery tab, then ask the tech " +
    "steward (or a workspace admin) to approve the delivery plan from the Decisions tab.",
  not_in_tech_review: "This project isn't in tech review — refresh the page and try again.",
  github_repo_create_failed: "GitHub couldn't create the repository. Try again in a moment.",
  github_seed_failed:
    "The repository was created but seeding the AI context files failed. Try again — it will pick up where it left off.",
  repo_name_taken: "That repository name is already taken — choose a different name.",
  // Distinct from repo_name_taken: the cloud resolved the conflicting
  // repository and confirmed it is NOT one this project created (plan 0016)
  // — a different name is the only fix, since retrying with the same one
  // hits the identical conflict every time.
  repo_name_collision:
    "That repository name belongs to a different, unrelated repository the workspace's GitHub token " +
    "can also see. Choose a different name for this project's repository, or rename the conflicting " +
    "one on GitHub first.",
  github_repo_not_in_token_scope:
    "The repository was created, but the workspace's GitHub token can't write to it — a token scoped to " +
    '"Only select repositories" never covers a repo created after it was issued. A workspace admin ' +
    'needs to set the token\'s repository access to "All repositories" (or add this new repo to the ' +
    "list) and reissue it, then try again — this will adopt the existing repo, not create a second one.",
  // ADR 0021 added Secrets/Variables write to what the workspace token needs.
  // Fine-grained PATs expose no way to check their own permissions, so this
  // cannot be caught on the connection form — it surfaces here, on a token
  // that has otherwise worked for months.
  github_secrets_not_in_token_scope:
    "The repository was created, but the workspace's GitHub token can't write repository secrets — " +
    "deployment needs them to hand credentials to the pipeline. A workspace admin needs to reissue " +
    "the token with Secrets and Variables write access, then try again — this will adopt the " +
    "existing repo, not create a second one.",
  github_secrets_failed:
    "GitHub couldn't store the deployment credentials. Try again in a moment.",
  deployment_provider_not_configured:
    "The selected deployment template's provider isn't configured. A workspace admin needs to " +
    "connect it in workspace settings before the repository can be created.",
  deployment_provider_incomplete:
    "The deployment provider's stored credential is missing something the template needs — " +
    "reconnect it in workspace settings.",
  deployment_preview_url_not_configured:
    "PromptWorkspace hosting isn't fully configured on this server, so there is no preview address to " +
    "give the pipeline. Contact your administrator.",
  // Plan 0027 M4: the platform never merges into, or silently skips, a
  // workflow the imported repository already has — the project would look
  // deployable and not be. The seed preview below names the file first.
  deploy_workflow_conflict:
    "The imported repository already has a .github/workflows/deploy.yml, and the deployment " +
    "template needs that path. PromptWorkspace never overwrites or merges into an existing workflow — " +
    "rename or remove that file on GitHub, then try again.",
  // The seed preview's refusals for an imported project (sync.py::seed_preview).
  repo_url_unrecognized: "The imported repository's address isn't a GitHub repository PromptWorkspace recognises.",
  repo_owner_out_of_scope:
    "The imported repository isn't under the workspace's connected GitHub account any more — the " +
    "connection may have been changed since the import.",
  imported_repo_not_found:
    "The imported repository can't be found on GitHub — it may have been renamed, moved or deleted.",
  github_unreachable: "GitHub couldn't be reached. Try again in a moment.",
  // The seed commit is pinned to the head the no-overwrite check read; a push
  // in between refuses the commit rather than writing over what it missed.
  repo_moved_during_seed:
    "Someone pushed to the repository's default branch while it was being set up, so nothing was " +
    "written. Check the file list again and retry.",
  // Any other refused ref update — branch protection or a ruleset. Retrying
  // can't help, unlike repo_moved_during_seed.
  default_branch_protected:
    "GitHub refused the setup commit on the default branch, usually because of branch protection " +
    "or a ruleset. Nothing was written. Ask a repository admin to lift the rule or exempt the " +
    "connected token's user, then retry.",
  // Create-repository and the seed preview alike: a directory GitHub won't
  // list in full leaves no complete answer to "is this path free".
  repo_tree_too_large:
    "A directory in this repository is too large for GitHub to list, so PromptWorkspace can't " +
    "check safely which files already exist. Nothing was written.",
};

/** `github_not_configured` is the one failure whose fix is a whole other form,
 *  so it gets the token requirements inline rather than a sentence pointing at
 *  a page that then explains them again. */
function NotConfiguredMessage({ workspaceId }: { workspaceId?: string }) {
  return (
    <>
      <p>No GitHub connection for this workspace yet.</p>
      <p className="mt-1 font-normal text-slate-600">
        A workspace admin needs to connect one under{" "}
        {workspaceId ? (
          <Link href={`/w/${workspaceId}/settings`} className="underline hover:text-slate-900">
            Workspace settings → GitHub connection
          </Link>
        ) : (
          <span className="font-medium">Workspace settings → GitHub connection</span>
        )}
        : the organisation or account plus a{" "}
        <a
          href="https://github.com/settings/personal-access-tokens"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-slate-900"
        >
          fine-grained personal access token
        </a>{" "}
        (<code>github_pat_…</code>) with <strong>Contents</strong>, <strong>Administration</strong>,{" "}
        <strong>Webhooks</strong>, <strong>Secrets</strong> and <strong>Variables</strong> write
        access. The token is verified against GitHub before it is stored, so a bad one fails on that
        form rather than here — except the last two, which GitHub gives no way to check in advance.
      </p>
    </>
  );
}

function describeError(message: string, workspaceId?: string): ReactNode {
  if (message === "github_not_configured") {
    return <NotConfiguredMessage workspaceId={workspaceId} />;
  }
  return DETAIL_MESSAGES[message] ?? message;
}

/** The seed commit for an imported repository, as the cloud computed it
 *  against the repository's live tree (plan 0027 M4) — what will actually be
 *  written, not the fixed list a new repository gets. */
function SeedPreviewList({ preview }: { preview: SeedPreview }) {
  const relocatedTo = new Set(preview.relocated.map((r) => r.to));
  const added = preview.write.filter((path) => !relocatedTo.has(path));
  return (
    <div className="mt-2 space-y-2 text-xs text-slate-600">
      {added.length > 0 && (
        <div>
          <p className="text-slate-500">Added in one commit:</p>
          <ul className="ml-4 mt-1 list-disc">
            {added.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.relocated.length > 0 && (
        <div>
          <p className="text-slate-500">
            Already in the repository, so PromptWorkspace&apos;s version is written beside it:
          </p>
          <ul className="ml-4 mt-1 list-disc">
            {preview.relocated.map((r) => (
              <li key={r.from}>
                {r.from} → {r.to}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.skipped.length > 0 && (
        <div>
          <p className="text-slate-500">Already in the repository and left as they are:</p>
          <ul className="ml-4 mt-1 list-disc">
            {preview.skipped.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.conflicts.length > 0 && (
        <div className="rounded bg-red-50 p-2 text-red-700">
          <p>
            These already exist and can&apos;t be written around — the deployment template needs
            exactly these paths, and PromptWorkspace never overwrites or merges into an existing
            workflow. Rename or remove them on GitHub, then check again:
          </p>
          <ul className="ml-4 mt-1 list-disc">
            {preview.conflicts.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function CreateRepositoryPanel({
  projectId,
  projectName,
  onCreated,
  constitutionReady,
  workspaceId,
  project,
  tasksReady,
}: {
  projectId: string;
  projectName: string;
  onCreated: () => void;
  /** Only used to link the "connect GitHub" fix straight to the settings page.
   *  Optional so the panel still renders standalone in tests. */
  workspaceId?: string;
  /** Whether the constitution document exists — the cloud refuses to seed a
   *  repository without one. Owned by the Planner, which is where the rules
   *  are written: this panel used to read the document itself, on mount, and
   *  so kept claiming it was missing after it had just been saved a few
   *  centimetres above. `undefined` means not loaded yet. */
  constitutionReady?: boolean;
  /** Whether the tasks document exists. Once the repo is created the whole
   *  Planner freezes (`Planner.tsx`'s `readOnly`), so a project that reaches
   *  `repo_created` with no tasks generated has no way back — this gate
   *  makes "generate tasks" a precondition of "create repository" rather
   *  than something to notice was missing after the fact. `undefined` means
   *  not loaded yet. */
  tasksReady?: boolean;
  /** When set and `project.repo_url` is already recorded (the project was
   *  imported, not started from scratch), the panel shows the repo it will
   *  adopt instead of a name/private form the server now ignores on that
   *  path — see create_repository's import branch in apps/cloud. */
  project?: Project;
}) {
  const { authHeaders } = useAuth();
  const [name, setName] = useState(() => slugify(projectName));
  const [isPrivate, setIsPrivate] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ReactNode | null>(null);
  const importedRepo = project?.repo_url;

  // An imported repository gets the seed preview instead of a fixed list.
  // Re-read when the template or policy scope changes (both add or remove
  // seeded paths) and after a failed create, since the repository on GitHub
  // may have changed under the preview.
  const [preview, setPreview] = useState<SeedPreview | null>(null);
  const [previewError, setPreviewError] = useState<ReactNode | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewKey = JSON.stringify([
    project?.deployment_config ?? null,
    project?.policy_scope ?? null,
  ]);
  useEffect(() => {
    if (!importedRepo) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    getSeedPreview(projectId, authHeaders())
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(describeError(err.message, workspaceId));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, importedRepo, previewKey, previewNonce]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      await createRepository(
        projectId,
        { name: name.trim() || undefined, private: isPrivate },
        authHeaders(),
      );
      onCreated();
    } catch (err) {
      setError(describeError((err as Error).message, workspaceId));
      if (importedRepo) setPreviewNonce((n) => n + 1);
    } finally {
      setCreating(false);
    }
  }

  const hasConflicts = (preview?.conflicts.length ?? 0) > 0;
  const disabled =
    creating || constitutionReady !== true || tasksReady !== true || hasConflicts;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">Create repository</h3>

      {importedRepo ? (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            This project will use the repository you imported:{" "}
            <a
              href={importedRepo}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline hover:text-slate-900"
            >
              {importedRepo}
            </a>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            No file already in the repository is overwritten. Where one of PromptWorkspace&apos;s
            documents would land on an existing file, it goes under docs/promptworkspace/ instead.
          </p>
          {previewLoading && !preview && (
            <p className="mt-2 text-xs text-slate-500">Checking the repository…</p>
          )}
          {previewError && <div className="mt-2 text-xs text-red-600">{previewError}</div>}
          {preview && <SeedPreviewList preview={preview} />}
          {(preview || previewError) && (
            <button
              type="button"
              disabled={previewLoading}
              onClick={() => setPreviewNonce((n) => n + 1)}
              className="mt-2 text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-60"
            >
              {previewLoading ? "Checking…" : "Check again"}
            </button>
          )}
        </div>
      ) : (
        <>
          <label className="mb-2 block text-xs text-slate-600">
            Repository name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
            />
          </label>

          <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            Private repository
          </label>
        </>
      )}

      {constitutionReady === false && (
        <p className="mb-2 text-xs text-amber-700">
          Fill in <strong>Project rules</strong> above first — that document seeds AGENTS.md in
          the new repo.
        </p>
      )}

      {hasConflicts && (
        <p className="mb-2 text-xs text-amber-700">
          The repository can&apos;t be created until the conflicting files above are renamed or
          removed on GitHub.
        </p>
      )}

      {constitutionReady === true && tasksReady === false && (
        <p className="mb-2 text-xs text-amber-700">
          Generate <strong>Tasks</strong> first — the repository is seeded with them.
        </p>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={handleCreate}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {creating ? "Creating…" : "Create repository"}
      </button>
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}
