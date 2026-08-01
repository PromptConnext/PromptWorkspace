// apps/web/src/components/project/CreateRepositoryPanel.tsx
"use client";

import { useEffect, useState } from "react";
import { createRepository, getStageDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Mirrors apps/engine/src/routes/projects.ts's slug derivation so the
// prefilled name matches what a desktop-side project creation would produce.
function slugify(name: string): string {
  return name.trim().replace(/[^\w-]+/g, "-").toLowerCase();
}

// Maps apps/cloud/app/api/sync.py's create-repository `detail` codes to
// sentences a business/tech-lead user can act on.
const DETAIL_MESSAGES: Record<string, string> = {
  not_in_tech_review: "This project isn't in tech review — refresh the page and try again.",
  github_not_configured:
    "A GitHub App installation must be configured for this workspace first (workspace admin).",
  github_repo_create_failed: "GitHub couldn't create the repository. Try again in a moment.",
  github_seed_failed:
    "The repository was created but seeding the AI context files failed. Try again — it will pick up where it left off.",
  repo_name_taken: "That repository name is already taken — choose a different name.",
  github_installation_scope:
    'The GitHub App installation can\'t see the repository it just created. A workspace admin needs to change the installation to "All repositories".',
};

function describeError(message: string): string {
  return DETAIL_MESSAGES[message] ?? message;
}

export function CreateRepositoryPanel({
  projectId,
  projectName,
  onCreated,
}: {
  projectId: string;
  projectName: string;
  onCreated: () => void;
}) {
  const { authHeaders } = useAuth();
  const [name, setName] = useState(() => slugify(projectName));
  const [isPrivate, setIsPrivate] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [constitutionEmpty, setConstitutionEmpty] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStageDocument(projectId, "constitution", authHeaders())
      .then((doc) => {
        if (!cancelled) setConstitutionEmpty(doc.content.trim().length === 0);
      })
      .catch(() => {
        if (!cancelled) setConstitutionEmpty(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
      setError(describeError((err as Error).message));
    } finally {
      setCreating(false);
    }
  }

  const disabled = creating || constitutionEmpty !== false;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">Create repository</h3>

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

      {constitutionEmpty === true && (
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
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
