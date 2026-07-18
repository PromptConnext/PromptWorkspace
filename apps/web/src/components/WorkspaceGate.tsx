"use client";

// The `/` gate: resolves which workspace the session should enter.
// - 0 memberships  -> empty state (get invited / create from desktop)
// - exactly 1      -> auto-enter it
// - remembered id  -> auto-resume it
// - many, none set -> picker
// Once an active workspace resolves, redirect into /w/{id}; the workspace pages
// own the actual content.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { ApiError } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

export function WorkspaceGate() {
  const router = useRouter();
  const { memberships, activeWorkspace, loading, error, setActiveWorkspace, createWorkspace } =
    useWorkspace();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createWorkspace(name);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  };

  // Auto-enter a single membership (no point showing a one-item picker).
  useEffect(() => {
    if (!loading && !activeWorkspace && memberships.length === 1) {
      setActiveWorkspace(memberships[0].id);
    }
  }, [loading, activeWorkspace, memberships, setActiveWorkspace]);

  // Once resolved (remembered or just auto-entered), redirect into the workspace.
  useEffect(() => {
    if (activeWorkspace) router.replace(`/w/${activeWorkspace.id}`);
  }, [activeWorkspace, router]);

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }
  if (activeWorkspace) {
    // redirect in flight
    return <div className="p-6 text-sm text-slate-500">Opening {activeWorkspace.name}…</div>;
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold">Your workspaces</h1>
        {memberships.length === 0 ? (
          <p className="mb-6 text-sm text-slate-500">
            No workspaces yet. Ask an admin to invite you, or create one below.
          </p>
        ) : (
          <ul className="mb-6 flex flex-col gap-2">
            {memberships.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => setActiveWorkspace(w.id)}
                  className="block w-full rounded border border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-400"
                >
                  <span className="font-medium">{w.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={handleCreate} className="flex flex-col gap-2 border-t border-slate-200 pt-6">
          <label htmlFor="new-workspace-name" className="text-sm font-medium text-slate-700">
            Create a new workspace
          </label>
          <div className="flex gap-2">
            <input
              id="new-workspace-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workspace name"
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              disabled={creating}
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          {createError ? <p className="text-sm text-red-600">{createError}</p> : null}
        </form>
      </main>
    </>
  );
}
