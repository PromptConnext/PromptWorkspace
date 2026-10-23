"use client";

import { memberFullName } from "@/components/project/MemberChip";
import { usePresence } from "@/lib/presence";
import type { WorkspaceMember } from "@/lib/types";

const UNKNOWN_TITLE = "Someone in this workspace";

// A raw user id is never shown. The members list carries an email only (no
// separate display name), so the chip is the email's first letter and the
// hover title is the email; an id the list doesn't know reads "?".
function identity(member: WorkspaceMember | undefined): { initial: string; title: string } {
  if (!member?.email) return { initial: "?", title: UNKNOWN_TITLE };
  return { initial: member.email.charAt(0).toUpperCase(), title: memberFullName(member) };
}

export function PresenceBar({
  projectId,
  members,
}: {
  projectId: string;
  members: WorkspaceMember[] | null | undefined;
}) {
  const roster = usePresence(projectId);
  if (roster.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span>Viewing now:</span>
      <div className="flex -space-x-1">
        {roster.map((entry) => {
          const { initial, title } = identity(members?.find((m) => m.user_id === entry.user_id));
          return (
            <span
              key={entry.user_id}
              title={title}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-white bg-slate-700 text-[10px] font-medium text-white"
            >
              {initial}
            </span>
          );
        })}
      </div>
    </div>
  );
}
