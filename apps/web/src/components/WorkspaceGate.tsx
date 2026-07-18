"use client";

// The `/` gate: resolves which workspace the session should enter.
// - 0 memberships  -> empty state (get invited / create from desktop)
// - exactly 1      -> auto-enter it
// - remembered id  -> auto-resume it
// - many, none set -> picker
// Once an active workspace resolves, redirect into /w/{id}; the workspace pages
// own the actual content.

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TopBar } from "@/components/TopBar";
import { useWorkspace } from "@/lib/workspace";

export function WorkspaceGate() {
  const router = useRouter();
  const { memberships, activeWorkspace, loading, error, setActiveWorkspace } = useWorkspace();

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
          <p className="text-sm text-slate-500">
            No workspaces yet. Ask an admin to invite you, or create one from the desktop app.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
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
      </main>
    </>
  );
}
