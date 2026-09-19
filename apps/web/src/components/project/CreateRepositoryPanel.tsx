// apps/web/src/components/project/CreateRepositoryPanel.tsx
"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import { createRepository } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DEPLOY_WORKFLOW_PATH, hasDeploymentTemplate, hasPolicyScope, SEEDED_FILES } from "./seedFiles";
import type { Project } from "@/lib/types";

// Mirrors apps/engine/src/routes/projects.ts's slug derivation so the
// prefilled name matches what a desktop-side project creation would produce.
function slugify(name: string): string {
  return name.trim().replace(/[^\w-]+/g, "-").toLowerCase();
}

// Maps apps/cloud/app/api/sync.py's create-repository `detail` codes to
// sentences a business/tech-lead user can act on.
const DETAIL_MESSAGES: Record<string, string> = {
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
    "PromptZone hosting isn't fully configured on this server, so there is no preview address to " +
    "give the pipeline. Contact your administrator.",
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

export function CreateRepositoryPanel({
  projectId,
  projectName,
  onCreated,
  constitutionReady,
  workspaceId,
  project,
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
    } finally {
      setCreating(false);
    }
  }

  const disabled = creating || constitutionReady !== true;
  const importedRepo = project?.repo_url;

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
            Existing files are kept; these are added or replaced in one commit:
          </p>
          <ul className="ml-4 mt-1 list-disc text-xs text-slate-600">
            {SEEDED_FILES.map((path) => (
              <li key={path}>{path}</li>
            ))}
            {project && hasPolicyScope(project) && <li>docs/policy-scope.md</li>}
            {project && hasDeploymentTemplate(project) && <li>{DEPLOY_WORKFLOW_PATH}</li>}
          </ul>
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
