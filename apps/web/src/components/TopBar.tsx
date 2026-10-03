"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

export function TopBar({ crumbs }: { crumbs?: { label: string; href?: string }[] }) {
  const { user, signOut } = useAuth();
  const { memberships, activeWorkspace, setActiveWorkspace, clearActiveWorkspace } = useWorkspace();
  const router = useRouter();

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/" className="font-semibold text-slate-900">
          PromptWorkspace
        </Link>
        {/* Rendered from one membership up, not two: a user with a single
            workspace still needs to see which one they are in, and the
            "All workspaces" option is their only route back to the gate —
            where a pending invitation would be waiting. */}
        {memberships.length >= 1 && (
          <Select
            value={activeWorkspace?.id ?? ""}
            onValueChange={(id) => {
              if (id === "__all__") {
                // Drop the remembered selection so the gate shows the picker
                // (and any pending invitation) instead of resuming this one.
                clearActiveWorkspace();
                router.push("/");
                return;
              }
              setActiveWorkspace(id);
              router.push(`/w/${id}`);
            }}
          >
            <SelectTrigger aria-label="Active workspace" className="ml-2">
              {/* The old blank <option> is a placeholder now — Radix reserves
                  the empty value for "nothing selected" and refuses it on an
                  item, which also means onValueChange can no longer hand back
                  the "" the previous handler had to guard against. */}
              <SelectValue placeholder="Select workspace…" />
            </SelectTrigger>
            <SelectContent>
              {memberships.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
              <SelectItem value="__all__">All workspaces…</SelectItem>
            </SelectContent>
          </Select>
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
