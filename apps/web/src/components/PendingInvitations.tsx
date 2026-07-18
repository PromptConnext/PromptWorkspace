"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { RoleBadge } from "@/components/RoleBadge";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { Invitation } from "@/lib/types";

export function PendingInvitations({
  workspaceId,
  registerRefetch,
}: {
  workspaceId: string;
  registerRefetch?: (fn: () => void) => void;
}) {
  const { authHeaders } = useAuth();
  const { data: invitations, refetch } = useCloudGet<Invitation[]>(
    `/workspaces/${workspaceId}/invitations`,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Let the parent trigger a refresh (e.g. after an invite is sent).
  // Runs in an effect, not render, to avoid a setState-in-render warning
  // (registerRefetch stores the fn on a ref owned by the parent).
  useEffect(() => {
    if (registerRefetch) registerRefetch(refetch);
  }, [registerRefetch, refetch]);

  async function revoke(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invitations/${id}`, authHeaders(), {
        method: "DELETE",
      });
      refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-slate-500">Pending invitations</h2>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {(invitations?.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">No pending invitations.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
          {invitations?.map((inv) => (
            <li key={inv.id} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                {inv.email}
              </span>
              <RoleBadge role={inv.role} />
              <button
                type="button"
                disabled={busyId === inv.id}
                onClick={() => revoke(inv.id)}
                className="rounded border border-slate-300 px-2 py-1 text-sm text-red-600 hover:border-red-300 disabled:opacity-60"
              >
                {busyId === inv.id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
