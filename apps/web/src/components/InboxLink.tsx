"use client";

import Link from "next/link";
import { useCloudGet } from "@/lib/hooks";
import type { InboxItem } from "@/lib/types";

/**
 * Link to the Inbox, with the number of items that need the caller. With
 * `include_mine` the API returns both open decisions routed to the caller and
 * the caller's own decisions that were sent back, so the count is the length.
 */
export function InboxLink({ workspaceId }: { workspaceId: string }) {
  const { data } = useCloudGet<InboxItem[]>(
    `/me/decisions?workspace_id=${encodeURIComponent(workspaceId)}&include_mine=true`,
    true,
    { refreshOnFocus: true },
  );
  const count = data?.length ?? 0;
  return (
    <Link
      href={`/w/${workspaceId}/inbox`}
      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
    >
      {count > 0 ? `Inbox · ${count}` : "Inbox"}
    </Link>
  );
}
