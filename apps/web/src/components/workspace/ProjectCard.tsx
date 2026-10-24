import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { MemberChip, memberFullName } from "@/components/project/MemberChip";
import { safeWebUrl } from "@/components/project/previewState";
import { relativeTime } from "@/lib/relativeTime";
import { useCloudGet } from "@/lib/hooks";
import type { ProjectCard as Card, RepositoryDocsStatus, WorkspaceMember } from "@/lib/types";

const CONTRIBUTOR_LIMIT = 5;
const LANGUAGE_LIMIT = 3;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function Hat({
  label,
  holderId,
  members,
  missingText,
  settingsHref,
  isAdmin,
}: {
  label: string;
  holderId: string | null;
  members: WorkspaceMember[];
  missingText: string;
  settingsHref: string;
  isAdmin: boolean;
}) {
  if (!holderId) {
    return isAdmin ? (
      <Link href={settingsHref} className="text-xs font-medium text-amber-700 hover:underline">
        {missingText}
      </Link>
    ) : (
      <span className="text-xs font-medium text-amber-700">{missingText}</span>
    );
  }
  const member = members.find((m) => m.user_id === holderId);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <MemberChip member={member} />
      <span className="shrink-0 text-xs text-slate-500">({label})</span>
    </span>
  );
}

export function ProjectCard({
  card,
  members,
  workspaceId,
  isAdmin,
}: {
  card: Card;
  members: WorkspaceMember[];
  workspaceId: string;
  isAdmin: boolean;
}) {
  const projectHref = `/w/${workspaceId}/p/${card.id}`;
  const settingsHref = `${projectHref}/settings`;
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const shown = card.contributors.slice(0, CONTRIBUTOR_LIMIT);
  const overflow = card.contributors.length - shown.length;

  const { in_progress, implemented, verified } = card.task_counts;
  const done = implemented + verified;
  const { open, overdue, expired_30d } = card.decisions;
  const liveUrl = safeWebUrl(card.live_url);
  // Lazy: only a repository-backed project that requires seeded rules can drift.
  const watchDocs = card.lifecycle_status === "repo_created" && card.policy.require_seeded_rules;
  const docs = useCloudGet<RepositoryDocsStatus>(
    `/projects/${card.id}/repository/docs-status`,
    watchDocs,
  );
  // The hook reports loading=true while disabled, so gate on watchDocs.
  const checkingDocs = watchDocs && docs.loading;
  const docsFailed = watchDocs && !!docs.error && !docs.data;
  const drifted = !!docs.data?.files.some((f) => f.state !== "current");
  // Server checks rank first; drift only speaks when none of them fail.
  const failingText =
    card.checks.find((c) => !c.ok)?.text ??
    (drifted ? "Rules in the repository differ from the plan" : null);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300">
      <div className="flex items-start justify-between gap-2">
        <Link href={projectHref} className="min-w-0 break-words font-medium text-slate-900 hover:underline">
          {card.name}
        </Link>
        {liveUrl && (
          // safeWebUrl: the live URL originates from a webhook payload, so a
          // javascript: URL must never reach an href (see ADR 0021).
          <a
            href={liveUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the live application"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-900 hover:border-emerald-300"
          >
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </a>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Hat
          label="Tech steward"
          holderId={card.hats.tech_steward}
          members={members}
          missingText="No tech steward"
          settingsHref={settingsHref}
          isAdmin={isAdmin}
        />
        <Hat
          label="Business owner"
          holderId={card.hats.business_owner}
          members={members}
          missingText="No business owner"
          settingsHref={settingsHref}
          isAdmin={isAdmin}
        />
      </div>

      {shown.length > 0 && (
        <div data-testid="contributors" className="flex items-center">
          {shown.map((id, i) => {
            const m = byId.get(id);
            return (
              <span
                key={id}
                title={memberFullName(m)}
                className={`rounded-full ring-2 ring-white ${i > 0 ? "-ml-2" : ""}`}
              >
                {m ? (
                  <Avatar identity={m} size="sm" />
                ) : (
                  <span
                    aria-hidden
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600"
                  >
                    ?
                  </span>
                )}
              </span>
            );
          })}
          {overflow > 0 && <span className="ml-2 text-xs text-slate-500">+{overflow}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {card.stack ? (
          [card.stack.runtime, ...card.stack.languages.slice(0, LANGUAGE_LIMIT)]
            .filter((b): b is string => !!b)
            .map((b) => (
              <span
                key={b}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
              >
                {b}
              </span>
            ))
        ) : (
          <span className="text-xs text-slate-400">Not analysed yet</span>
        )}
      </div>

      <p className="text-sm text-slate-600">
        <span>{`${in_progress} in progress · ${done} done`}</span>
        {open > 0 && (
          <>
            {" · "}
            <Link
              href={`${projectHref}?tab=decisions`}
              className={`hover:underline ${overdue > 0 ? "font-medium text-amber-700" : "text-slate-600"}`}
            >
              {overdue > 0
                ? plural(overdue, "decision overdue", "decisions overdue")
                : `${plural(open, "decision", "decisions")} waiting`}
            </Link>
          </>
        )}
        {card.agent_closed_30d > 0 && ` · ${card.agent_closed_30d} closed by agents`}
      </p>
      {expired_30d > 0 && (
        <p className="text-xs text-amber-700">
          {plural(expired_30d, "decision", "decisions")} expired without an answer
        </p>
      )}

      <p
        className={`flex items-start gap-1.5 text-xs ${
          failingText || docsFailed ? "text-amber-700" : checkingDocs ? "text-slate-500" : "text-emerald-700"
        }`}
      >
        {failingText ? (
          <span className="text-amber-700">{failingText}</span>
        ) : docsFailed ? (
          <span className="text-amber-700">Could not check the repository rules</span>
        ) : checkingDocs ? (
          <span className="text-slate-500">Checking repository rules…</span>
        ) : (
          <>
            <span aria-hidden>✓</span>
            <span>Follows workspace rules</span>
          </>
        )}
      </p>

      <p className="mt-auto text-xs text-slate-400">
        Updated {relativeTime(card.last_activity_at)}
      </p>
    </div>
  );
}
