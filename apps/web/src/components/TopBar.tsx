"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { NewWorkspaceDialog } from "@/components/NewWorkspaceDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";

export function TopBar({
  crumbs,
}: {
  /** `loading` shows a placeholder bar in place of a label not known yet. */
  crumbs?: { label: string; href?: string; loading?: boolean }[];
}) {
  const { user, signOut } = useAuth();
  const { memberships, activeWorkspace, setActiveWorkspace, clearActiveWorkspace, createWorkspace } =
    useWorkspace();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  // Set when the switcher closed because "New workspace…" was chosen, so its
  // close handler can skip restoring focus to the trigger: that restore would
  // pull focus out from under the dialog that is opening.
  const choseNew = useRef(false);

  return (
    <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 py-3 sm:px-6">
      <nav className="flex min-w-0 items-center gap-2 text-sm">
        <Link href="/" className="shrink-0 font-semibold text-slate-900">
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
              if (id === "__new__") {
                // An action, not a workspace: open the dialog and leave the
                // selection and route alone.
                choseNew.current = true;
                setCreating(true);
                return;
              }
              setActiveWorkspace(id);
              router.push(`/w/${id}`);
            }}
          >
            <SelectTrigger aria-label="Active workspace" className="ml-2 max-w-[8rem] min-w-0 sm:max-w-[14rem]">
              {/* The old blank <option> is a placeholder now — Radix reserves
                  the empty value for "nothing selected" and refuses it on an
                  item, which also means onValueChange can no longer hand back
                  the "" the previous handler had to guard against. */}
              <SelectValue placeholder="Select workspace…" />
            </SelectTrigger>
            <SelectContent
              onCloseAutoFocus={(e) => {
                if (choseNew.current) {
                  e.preventDefault();
                  choseNew.current = false;
                }
              }}
            >
              {memberships.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
              <SelectItem value="__all__">All workspaces…</SelectItem>
              <SelectSeparator />
              <SelectItem value="__new__">New workspace…</SelectItem>
            </SelectContent>
          </Select>
        )}
        {crumbs?.map((c, i) => (
          <span
            key={c.label}
            data-testid="crumb"
            className={`min-w-0 items-center gap-2 text-slate-500 ${
              i === crumbs.length - 1 ? "flex" : "hidden sm:flex"
            }`}
          >
            <span aria-hidden>/</span>
            {c.loading ? (
              <span
                data-testid="crumb-skeleton"
                className="inline-block h-3.5 w-24 shrink-0 animate-pulse rounded bg-slate-200 motion-reduce:animate-none"
              >
                <span className="sr-only">{c.label}</span>
              </span>
            ) : c.href ? (
              <Link href={c.href} title={c.label} className="min-w-0 max-w-[10rem] truncate hover:text-slate-900 sm:max-w-xs">
                {c.label}
              </Link>
            ) : (
              <span title={c.label} className="min-w-0 max-w-[10rem] truncate text-slate-900 sm:max-w-xs">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex shrink-0 items-center gap-3 text-sm text-slate-500">
        <span className="hidden max-w-[16rem] truncate md:inline" title={user?.email}>
          {user?.email}
        </span>
        <button onClick={() => void signOut()} className="shrink-0 whitespace-nowrap rounded border border-slate-300 px-2 py-1">
          Sign out
        </button>
      </div>
      <NewWorkspaceDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={async (name) => {
          const ws = await createWorkspace(name);
          router.push(`/w/${ws.id}`);
        }}
      />
    </header>
  );
}
