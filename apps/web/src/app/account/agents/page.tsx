"use client";

// Every agent the user has connected through hosted MCP OAuth, one row per
// approval (refresh-token family). Revoking kills that family's tokens on the
// cloud; "Revoke all" is the panic button and takes a second click.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { listOauthGrants, revokeAllOauthGrants, revokeOauthGrant } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { OAuthGrantOut } from "@/lib/types";

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function AgentsView() {
  const { authHeaders } = useAuth();
  const [grants, setGrants] = useState<OAuthGrantOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrants(await listOauthGrants(authHeaders()));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    // authHeaders changes identity on every token refresh; reload on demand only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      setConfirmAll(false);
    }
  }

  const anyActive = grants?.some((g) => !g.revoked_at) ?? false;

  return (
    <>
      <TopBar crumbs={[{ label: "Connected agents" }]} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Link href="/" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
          ← Workspaces
        </Link>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Connected agents</h1>
          {anyActive &&
            (confirmAll ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run("all", () => revokeAllOauthGrants(authHeaders()))}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60"
                >
                  Confirm: revoke all
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmAll(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmAll(true)}
                className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Revoke all
              </button>
            ))}
        </div>

        {error && (
          <p role="alert" className="mb-4 text-sm text-red-600">
            {error}
          </p>
        )}

        {grants === null ? (
          !error && <p className="text-sm text-slate-500">Loading…</p>
        ) : grants.length === 0 ? (
          <p className="text-sm text-slate-500">No agents are connected to your account.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium">Vendor</th>
                  <th className="py-2 pr-3 font-medium">Connected</th>
                  <th className="py-2 pr-3 font-medium">Last used</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {grants.map((g) => (
                  <tr key={g.family_id}>
                    <td className="py-2 pr-3 text-slate-900">{g.client_name}</td>
                    <td className="py-2 pr-3">
                      {g.vendor && <span className="mr-2 text-slate-700">{g.vendor}</span>}
                      {g.verified ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
                          Verified
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                          Unverified
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{formatDate(g.created_at)}</td>
                    <td className="py-2 pr-3 text-slate-600">{formatDate(g.last_used_at)}</td>
                    <td className="py-2 pr-3">{g.revoked_at ? "Revoked" : "Active"}</td>
                    <td className="py-2 text-right">
                      {!g.revoked_at && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run(g.family_id, () => revokeOauthGrant(g.family_id, authHeaders()))}
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                          {busy === g.family_id ? "Revoking…" : "Revoke"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

export default function ConnectedAgentsPage() {
  return (
    <RequireAuth next="/account/agents">
      <AgentsView />
    </RequireAuth>
  );
}
