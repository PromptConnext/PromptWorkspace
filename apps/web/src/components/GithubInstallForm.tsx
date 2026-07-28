// apps/web/src/components/GithubInstallForm.tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Workspace } from "@/lib/types";

// Minimal admin surface for apps/cloud/app/api/github.py's
// POST /workspaces/{id}/integrations/github/install — otherwise that
// endpoint is curl-only and the create-repository flow (which reads
// workspace.integration_config["github"]) is unreachable for a real user.
export function GithubInstallForm({
  workspaceId,
  onInstalled,
}: {
  workspaceId: string;
  onInstalled: () => void;
}) {
  const { authHeaders } = useAuth();
  const [projectId, setProjectId] = useState("");
  const [owner, setOwner] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [repo, setRepo] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch<Workspace>(
        `/workspaces/${workspaceId}/integrations/github/install`,
        authHeaders(),
        {
          method: "POST",
          body: JSON.stringify({
            project_id: projectId,
            owner: owner || undefined,
            installation_id: installationId,
            repo,
            default_branch: defaultBranch,
          }),
        },
      );
      setSaved(true);
      onInstalled();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">GitHub App installation</h2>
      <p className="mb-3 text-xs text-slate-500">
        After completing the GitHub App install flow on GitHub, record its details here so the
        Tech Lead can create repositories from a project.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Project ID</span>
          <input
            type="text"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Owner / org</span>
          <input
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="my-org"
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </label>
        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Installation ID</span>
          <input
            type="text"
            value={installationId}
            onChange={(e) => setInstallationId(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Repo (owner/name)</span>
          <input
            type="text"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="my-org/my-repo"
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Default branch</span>
          <input
            type="text"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save installation"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {saved && <p className="mt-3 text-sm text-emerald-700">Saved.</p>}
    </section>
  );
}
