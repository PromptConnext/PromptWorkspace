"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

/**
 * `next`, when given, is where login sends the user back to. The login page
 * runs it through safeNext, so only an in-app path survives.
 */
export function RequireAuth({ children, next }: { children: React.ReactNode; next?: string }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
    }
  }, [loading, user, router, next]);

  if (loading || !user) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  return <>{children}</>;
}
