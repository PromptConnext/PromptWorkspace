"use client";

import { usePresence } from "@/lib/presence";

export function PresenceBar({ projectId }: { projectId: string }) {
  const roster = usePresence(projectId);
  if (roster.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span>Viewing now:</span>
      <div className="flex -space-x-1">
        {roster.map((entry) => (
          <span
            key={entry.user_id}
            title={entry.user_id}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-white bg-slate-700 text-[10px] font-medium text-white"
          >
            {entry.user_id.slice(0, 2).toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  );
}
