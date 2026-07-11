"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch, ApiError } from "@/lib/api";
import type { WorkspaceMember } from "@/lib/types";

function AcceptInvitation({ token }: { token: string }) {
  const { user, loading: authLoading, authHeaders } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<"pending" | "accepting" | "done" | "error">("pending");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }
    if (status !== "pending") return;
    setStatus("accepting");
    apiFetch<WorkspaceMember>(`/invitations/${token}/accept`, authHeaders(), { method: "POST" })
      .then((member) => {
        setStatus("done");
        router.replace(`/w/${member.workspace_id}`);
      })
      .catch((err: ApiError) => {
        setStatus("error");
        setError(err.message);
      });
  }, [authLoading, user, token, status, authHeaders, router]);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 px-4 text-center">
      {status === "error" ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <p className="text-sm text-slate-500">Accepting invitation…</p>
      )}
    </main>
  );
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <AcceptInvitation token={token} />;
}
