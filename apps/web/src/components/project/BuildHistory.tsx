// apps/web/src/components/project/BuildHistory.tsx
//
// The version list the deployment API has always returned as `recent[]` and
// the UI has never rendered (ADR 0023 phase 1).
//
// ADR 0023 decision 6 is enforced here rather than by convention: a member
// sees a version ordinal, a state and a relative time. The commit and the
// build log are how a Tech Lead diagnoses a red build, so they render only
// for a workspace admin.
"use client";

import type { BuildVersion } from "./previewState";
import { relativeTime } from "./previewState";

const STATE_COPY: Record<string, string> = {
  live: "Published",
  failed: "Did not publish",
  building: "Building",
  queued: "Queued",
  inactive: "Replaced by a newer version",
};

export function BuildHistory({
  versions,
  isAdmin,
}: {
  versions: BuildVersion[];
  isAdmin: boolean;
}) {
  if (versions.length === 0) return null;
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h4 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Version history
      </h4>
      <ul className="divide-y divide-slate-100">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span className="text-sm font-medium text-slate-900">{v.label}</span>
            <span className="text-xs text-slate-500">
              {STATE_COPY[v.state] ?? v.state} · {relativeTime(v.at)}
              {isAdmin && v.deploy.commit_sha && (
                <>
                  {" · "}
                  <code className="text-slate-400">{v.deploy.commit_sha.slice(0, 7)}</code>
                </>
              )}
              {isAdmin && v.deploy.run_url && (
                <>
                  {" · "}
                  <a href={v.deploy.run_url} target="_blank" rel="noreferrer" className="underline">
                    build log
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
