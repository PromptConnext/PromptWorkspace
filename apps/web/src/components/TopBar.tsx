"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

export function TopBar({ crumbs }: { crumbs?: { label: string; href?: string }[] }) {
  const { user, signOut } = useAuth();

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/" className="font-semibold text-slate-900">
          PromptZone
        </Link>
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
