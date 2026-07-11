"use client";

import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useCloudGet } from "@/lib/hooks";
import type { Workspace } from "@/lib/types";

function WorkspaceSwitcher() {
  const { data: workspaces, error, loading } = useCloudGet<Workspace[]>("/workspaces");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold">Your workspaces</h1>
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {workspaces && workspaces.length === 0 && (
          <p className="text-sm text-slate-500">
            No workspaces yet. Ask an admin to invite you, or create one from the desktop app.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {workspaces?.map((w) => (
            <li key={w.id}>
              <Link
                href={`/w/${w.id}`}
                className="block rounded border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
              >
                <span className="font-medium">{w.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}

export default function HomePage() {
  return (
    <RequireAuth>
      <WorkspaceSwitcher />
    </RequireAuth>
  );
}
