// apps/web/src/components/NewProjectDialog.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createProject, listGithubRepos } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { DEPLOY_WORKFLOW_PATH, SEEDED_FILES } from "./project/seedFiles";
import type { GithubRepo, GithubRepoList, Project } from "@/lib/types";

// Maps error codes from POST /projects (import path) and the repo-listing
// route to sentences a business user can act on. Per-component map, house
// convention — see CreateRepositoryPanel.tsx's DETAIL_MESSAGES.
const DETAIL_MESSAGES: Record<string, string> = {
  github_not_configured: "No GitHub connection for this workspace yet.",
  github_token_rejected:
    "The workspace's GitHub token no longer works — a workspace admin needs to reconnect it.",
  github_unreachable: "GitHub couldn't be reached. Try again in a moment.",
  github_rate_limited: "Too many refreshes — wait a few seconds and try again.",
  repo_owner_out_of_scope:
    "That repository isn't under the workspace's connected GitHub account.",
  repo_not_found: "That repository is gone — refresh the list and try again.",
  repo_already_imported: "Another project in this workspace already imports that repository.",
  repo_is_empty:
    "That repository has no commits yet — PromptConnext can only add files on top of an existing one.",
  invalid_repo_full_name: "That doesn't look like a repository — refresh the list and try again.",
  github_repo_not_in_token_scope:
    'The workspace\'s GitHub token can\'t read that repository — a token scoped to "Only select ' +
    'repositories" may not cover it. A workspace admin needs to add it to the token\'s access and ' +
    "reissue it.",
};

function describeError(message: string): string {
  return DETAIL_MESSAGES[message] ?? message;
}

type Step = "choice" | "scratch" | "pick" | "confirm";

export function NewProjectDialog({
  open,
  workspaceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const { authHeaders } = useAuth();
  const [step, setStep] = useState<Step>("choice");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [consent, setConsent] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("choice");
    setName("");
    setSelected(null);
    setConsent(false);
    setFilter("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const {
    data: repoList,
    error: listError,
    loading: listLoading,
    refetch: refetchRepos,
  } = useCloudGet<GithubRepoList>(
    `/workspaces/${workspaceId}/integrations/github/repos`,
    step === "pick",
  );

  if (!open) return null;

  async function createScratch() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({ name: name.trim(), workspace_id: workspaceId }, authHeaders());
      reset();
      onCreated(project);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createImport() {
    if (!selected || !consent) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(
        {
          name: name.trim() || selected.name,
          workspace_id: workspaceId,
          import_repo_full_name: selected.full_name,
        },
        authHeaders(),
      );
      reset();
      onCreated(project);
    } catch (err) {
      setError(describeError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  function pickRepo(repo: GithubRepo) {
    setSelected(repo);
    setName(repo.name);
    setConsent(false);
    setError(null);
    setStep("confirm");
  }

  const filtered = (repoList?.repositories ?? []).filter((r) =>
    r.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">New project</h2>
          <button
            type="button"
            onClick={close}
            className="text-sm text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        {step === "choice" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setStep("scratch")}
              className="rounded-lg border border-slate-200 p-4 text-left hover:border-slate-400"
            >
              <p className="text-sm font-medium text-slate-900">Start from scratch</p>
              <p className="mt-1 text-xs text-slate-500">
                A new, empty project — the usual PromptConnext flow.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setStep("pick")}
              className="rounded-lg border border-slate-200 p-4 text-left hover:border-slate-400"
            >
              <p className="text-sm font-medium text-slate-900">Import a GitHub repository</p>
              <p className="mt-1 text-xs text-slate-500">
                Brought an app over from Lovable, v0, Replit or AI Studio? Bring the repo in and
                keep building here.
              </p>
            </button>
          </div>
        )}

        {step === "scratch" && (
          <div>
            <label className="mb-2 block text-xs text-slate-600">
              Project name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createScratch();
                }}
                placeholder="Project name"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
              />
            </label>
            {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("choice")}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || !name.trim()}
                onClick={createScratch}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        )}

        {step === "pick" && (
          <div>
            {listLoading && <p className="text-sm text-slate-500">Loading repositories…</p>}
            {listError && <p className="text-sm text-red-600">{describeError(listError)}</p>}

            {repoList && repoList.repositories.length === 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p>
                  The workspace's GitHub connection is for{" "}
                  <strong>{repoList.owner ?? "an account with no repositories"}</strong>.
                  PromptConnext can only see repositories under that account.
                </p>
                <p className="mt-1">
                  Move your repository to {repoList.owner ?? "that account"}, or ask a workspace
                  admin to connect a token for the account that owns it —{" "}
                  <Link href={`/w/${workspaceId}/settings`} className="underline hover:text-amber-950">
                    Workspace settings → GitHub connection
                  </Link>
                  .
                </p>
              </div>
            )}

            {repoList && repoList.repositories.length > 0 && (
              <>
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter repositories…"
                  className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                />
                {repoList.truncated && (
                  <p className="mb-2 text-xs text-amber-700">
                    Showing the most recently pushed repositories. Type to filter within them.
                  </p>
                )}
                <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                  {filtered.map((r) => {
                    const disabledReason = r.archived
                      ? "archived on GitHub — unarchive it first, PromptConnext must be able to push"
                      : r.empty
                        ? "no commits yet — PromptConnext can only add files on top of an existing commit"
                        : null;
                    return (
                      <li key={r.full_name}>
                        <button
                          type="button"
                          disabled={!!disabledReason}
                          onClick={() => pickRepo(r)}
                          className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="flex items-center gap-2 font-medium text-slate-900">
                            {r.name}
                            {r.private && <span className="text-xs text-slate-400">private</span>}
                          </span>
                          <span className="text-xs text-slate-500">
                            {r.default_branch}
                            {disabledReason ? ` — ${disabledReason}` : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {filtered.length === 0 && (
                    <li className="px-3 py-2 text-sm text-slate-500">No matches.</li>
                  )}
                </ul>
              </>
            )}

            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("choice")}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Back
              </button>
              <button
                type="button"
                onClick={refetchRepos}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Refresh
              </button>
            </div>
          </div>
        )}

        {step === "confirm" && selected && (
          <div>
            <label className="mb-3 block text-xs text-slate-600">
              Project name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
              />
            </label>

            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p>
                When your Tech Lead creates the repository for this project, PromptConnext adds
                these files to <strong>{selected.full_name}</strong> in a single commit on{" "}
                <strong>{selected.default_branch}</strong>. Anything already at these paths is
                replaced; every other file is left untouched. Nothing is written to GitHub now.
              </p>
              <ul className="ml-4 mt-2 list-disc text-slate-600">
                {SEEDED_FILES.map((path) => (
                  <li key={path}>{path}</li>
                ))}
                <li>{DEPLOY_WORKFLOW_PATH} (if you choose a deployment template)</li>
              </ul>
            </div>

            <label className="mb-3 flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
              />
              I understand these files will be added to {selected.full_name}.
            </label>

            {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep("pick")}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || !consent || !name.trim()}
                onClick={createImport}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
