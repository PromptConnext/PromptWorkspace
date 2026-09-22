// apps/web/src/components/project/BuildTasks.tsx
//
// "What's in this build" (ADR 0023 decision 5).
//
// The line the platform could not previously draw: a task board in one tab, a
// running application in another, and nothing connecting them. This is that
// connection, and it is deliberately written in the spec's vocabulary — a
// version ordinal, a time and task titles. No SHA, no branch, no run URL
// (decision 6).
"use client";

import type { DeploymentStatus } from "@/lib/types";
import { buildVersions, relativeTime } from "./previewState";

export function BuildTasks({
  status,
  onDiscuss,
}: {
  status: DeploymentStatus;
  /** Opens a discussion bound to this task. Absent until Phase 5. */
  onDiscuss?: (taskId: string) => void;
}) {
  const deploy = status.last_deploy;
  if (!deploy) return null;
  const version = buildVersions(status).find((v) => v.id === deploy.id);
  const label = version?.label ?? "Latest version";

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-slate-900">What&rsquo;s in this build</h4>
        <p className="text-xs text-slate-500">
          {label} · {relativeTime(deploy.created_at)}
        </p>
      </header>
      {/* Two empty states, because they are two different facts (plan 0024
          M3). "This build closed nothing" is a complete answer. "Nobody ever
          worked out what this build closed" is a hole in the evidence chain,
          and it has a cause worth naming: attribution resolves the commit
          range through the workspace's code-host token, and when that is
          missing or the host is unreachable the server records what it can
          and moves on rather than failing the webhook. Rendering both as one
          sentence told a reviewer a gap was a zero. */}
      {deploy.attribution_state !== "frozen" ? (
        <p className="mt-2 text-xs text-slate-500">
          We haven&rsquo;t worked out which tasks are in this version. That usually means the
          connection to the code host was unavailable when it published; an admin can record it
          again.
        </p>
      ) : deploy.tasks.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          This version contains no completed tasks.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {deploy.tasks.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-800">{task.title}</span>
              {onDiscuss && (
                <button
                  type="button"
                  onClick={() => onDiscuss(task.id)}
                  className="shrink-0 rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-slate-300"
                >
                  Comment
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
