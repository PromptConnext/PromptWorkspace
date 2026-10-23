"use client";

import Link from "next/link";
import { use } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useCloudGet } from "@/lib/hooks";
import type { InboxItem } from "@/lib/types";
import { useWorkspaceName } from "@/lib/workspace";

function InboxView({ workspaceId }: { workspaceId: string }) {
  const workspaceName = useWorkspaceName(workspaceId);
  const { data: items, error, loading } = useCloudGet<InboxItem[]>(
    `/me/decisions?workspace_id=${encodeURIComponent(workspaceId)}&include_mine=true`,
    true,
    { refreshOnFocus: true },
  );

  const waiting = (items ?? []).filter((i) => i.decision.status === "open");
  const sentBack = (items ?? []).filter((i) => i.decision.status === "rejected");

  return (
    <>
      <TopBar crumbs={[{ label: workspaceName, href: `/w/${workspaceId}` }, { label: "Inbox" }]} />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-slate-900">Decisions waiting on you</h1>
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
        {loading && !items && <p className="text-sm text-slate-500">Loading…</p>}
        {items && waiting.length === 0 && (
          <p className="text-sm text-slate-500">Nothing is waiting on you.</p>
        )}
        <ul className="flex flex-col gap-3">
          {waiting.map((item) => (
            <li key={item.decision.id}>
              {/* The whole card is the link: a card that looks clickable must be. */}
              <Link
                href={`/w/${item.workspace_id}/p/${item.project_id}?tab=decisions`}
                className="block rounded-lg border border-slate-200 bg-white p-3 hover:border-slate-300"
              >
                <span className="text-sm font-medium text-slate-900">{item.decision.title}</span>
                <p className="mt-1 text-xs text-slate-500">
                  <span>{item.project_name}</span> · {new Date(item.decision.created_at).toLocaleString()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
        {sentBack.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-lg font-semibold tracking-tight text-slate-900">Sent back to you</h2>
            <ul className="flex flex-col gap-3">
              {sentBack.map((item) => (
                <li key={item.decision.id}>
                  <Link
                    href={`/w/${item.workspace_id}/p/${item.project_id}?tab=decisions`}
                    className="block rounded-lg border border-rose-200 bg-white p-3 hover:border-rose-300"
                  >
                    <span className="text-sm font-medium text-slate-900">{item.decision.title}</span>
                    <p className="mt-1 text-xs text-slate-500">{item.project_name}</p>
                    {item.decision.rationale && (
                      <p className="mt-2 text-sm text-slate-700">{item.decision.rationale}</p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

export default function InboxPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <InboxView workspaceId={workspaceId} />
    </RequireAuth>
  );
}
