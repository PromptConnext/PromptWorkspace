"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";

export function TopBar({ crumbs }: { crumbs?: { label: string; href?: string }[] }) {
  const { user, signOut } = useAuth();
  const { memberships, activeWorkspace, setActiveWorkspace, clearActiveWorkspace } = useWorkspace();
  const router = useRouter();

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/" className="font-semibold text-slate-900">
          PromptConnext
        </Link>
        {/* Rendered from one membership up, not two: a user with a single
            workspace still needs to see which one they are in, and the
            "All workspaces" option is their only route back to the gate —
            where a pending invitation would be waiting. */}
        {memberships.length >= 1 && (
          <select
            aria-label="Active workspace"
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-slate-700"
            value={activeWorkspace?.id ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (id === "__all__") {
                // Drop the remembered selection so the gate shows the picker
                // (and any pending invitation) instead of resuming this one.
                clearActiveWorkspace();
                router.push("/");
                return;
              }
              if (!id) return;
              setActiveWorkspace(id);
              router.push(`/w/${id}`);
            }}
          >
            {!activeWorkspace && <option value="">Select workspace…</option>}
            {memberships.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value="__all__">All workspaces…</option>
          </select>
        )}
        {crumbs?.map((c) => (
          <span key={c.label} className="flex items-center gap-2 text-slate-500">
            <span>/</span>
            {c.href ? (
              <Link href={c.href} className="hover:text-slate-900">
                {c.label}
              </Link>
            ) : (
              <span className="text-slate-900">{c.label}</span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <span>{user?.email}</span>
        <button onClick={() => void signOut()} className="rounded border border-slate-300 px-2 py-1">
          Sign out
        </button>
      </div>
    </header>
  );
}
