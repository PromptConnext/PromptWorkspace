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
  const { data: items, error } = useCloudGet<InboxItem[]>(
    `/me/decisions?workspace_id=${encodeURIComponent(workspaceId)}`,
    true,
    { refreshOnFocus: true },
  );

  return (
    <>
      <TopBar crumbs={[{ label: workspaceName, href: `/w/${workspaceId}` }, { label: "Inbox" }]} />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-slate-900">Decisions waiting on you</h1>
        {error && <p className="text-sm text-rose-700">{error}</p>}
        {items && items.length === 0 && (
          <p className="text-sm text-slate-500">Nothing is waiting on you.</p>
        )}
        <ul className="flex flex-col gap-3">
          {(items ?? []).map((item) => (
            <li key={item.decision.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <Link
                href={`/w/${item.workspace_id}/p/${item.project_id}?tab=decisions`}
                className="text-sm font-medium text-slate-900 hover:underline"
              >
                {item.decision.title}
              </Link>
              <p className="mt-1 text-xs text-slate-500">
                <span>{item.project_name}</span> · {new Date(item.decision.created_at).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
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
