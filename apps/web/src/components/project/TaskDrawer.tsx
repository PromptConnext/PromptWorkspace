"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { specLabel } from "@/lib/boardFilters";
import { taskRefLabel } from "@/lib/taskOrder";
import type {
  AgentRun,
  AgentRunStatus,
  Artifact,
  ProjectGraph,
  Task,
  TaskStatus,
  WorkspaceMember,
} from "@/lib/types";
import { memberFullName } from "./MemberChip";
import { STATUS_LABEL } from "./taskBoardA11y";
import { InlineCodeText, isHttpUrl } from "./TaskCard";

/**
 * A task's full record, as a right-side sheet over the board.
 *
 * A card is a summary: two lines of title, the assignee, the status. The
 * drawer is where everything else lives — every acceptance criterion, the
 * spec it came from, the commits that closed it, what agents did with it —
 * without leaving the board, so the filters and scroll position you had are
 * still there when you close it.
 *
 * The assignee and move controls are slots rather than built in here: the
 * board already owns those controls and their optimistic write path, and a
 * second copy of either would be a second place for the permission rules to
 * drift.
 */

const STATUS_STYLE: Record<TaskStatus, string> = {
  todo: "bg-slate-100 text-slate-700",
  in_progress: "bg-blue-100 text-blue-700",
  implemented: "bg-violet-100 text-violet-700",
  verified: "bg-emerald-100 text-emerald-700",
};

const RUN_STATUS_STYLE: Record<AgentRunStatus, string> = {
  running: "bg-blue-100 text-blue-700",
  succeeded: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

const KIND_LABEL: Record<Artifact["kind"], string> = {
  code: "Code",
  doc: "Doc",
  test: "Test",
  other: "Other",
};

const RECENT_RUNS = 5;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1";

const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return relativeFormat.format(0, "minute");
}

function TimeStamp({ iso }: { iso: string | null }) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  return (
    <time dateTime={iso} title={absoluteFormat.format(new Date(iso))} className="tabular-nums">
      {relativeTime(iso)}
    </time>
  );
}

function memberLabel(members: WorkspaceMember[], userId: string | null): string {
  if (!userId) return "Unassigned";
  return memberFullName(members.find((m) => m.user_id === userId));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-slate-100 px-5 py-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  const linkable = isHttpUrl(artifact.uri);
  const label = artifact.commit_sha ? (
    <span translate="no" className="font-mono">
      {artifact.commit_sha.slice(0, 7)}
    </span>
  ) : (
    <span className="break-all">{artifact.uri}</span>
  );
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
        {artifact.commit_sha ? "Commit" : KIND_LABEL[artifact.kind]}
      </span>
      {linkable ? (
        <a
          href={artifact.uri}
          target="_blank"
          rel="noreferrer"
          title={artifact.uri}
          className={`min-w-0 text-blue-700 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          {label}
        </a>
      ) : (
        <span className="min-w-0 text-slate-700">{label}</span>
      )}
    </li>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${RUN_STATUS_STYLE[run.status]}`}
      >
        {run.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-slate-700" title={`${run.model_role} · ${run.action}`}>
        {run.action}
        <span className="text-slate-400"> · {run.model_role}</span>
      </span>
      <span className="shrink-0 text-xs text-slate-400">
        <TimeStamp iso={run.updated_at} />
      </span>
    </li>
  );
}

function CopyLinkButton() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        className={[
          "h-8 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700",
          "transition-colors hover:border-slate-400 hover:bg-slate-50",
          FOCUS_RING,
        ].join(" ")}
      >
        Copy Link
      </button>
      <span aria-live="polite" className="text-xs text-slate-500">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : ""}
      </span>
    </div>
  );
}

export function TaskDrawer({
  task,
  graph,
  members,
  artifacts = [],
  onClose,
  renderAssignee,
  renderMove,
}: {
  task: Task | null;
  graph: ProjectGraph;
  members: WorkspaceMember[];
  /** This task's live artifacts, as the board already grouped them. */
  artifacts?: Artifact[];
  onClose: () => void;
  renderAssignee?: (task: Task) => ReactNode;
  renderMove?: (task: Task) => ReactNode;
}) {
  const open = task !== null;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Keyed on open/closed, not on the task: stepping from one task to another
  // while the drawer stays open must not re-capture the "return focus here"
  // element (it would capture something inside the drawer).
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const frame = requestAnimationFrame(() => setEntered(true));

    function onKeyDown(event: KeyboardEvent) {
      // Radix closes an open Select on Escape from a capture listener and
      // marks the event handled; that press belongs to the Select, not to us.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    }
    // Bubble phase on document: after Radix's capture listener, and before
    // board shortcuts listening on window, which skip handled events.
    document.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      setEntered(false);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [open]);

  if (!task) return null;

  function trapTab(event: React.KeyboardEvent) {
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const ref = taskRefLabel(task) ?? task.feature_tag;
  const criteria = task.acceptance_criteria;
  const spec = task.spec_id ? graph.spec_documents.find((s) => s.id === task.spec_id) : undefined;
  const runs = graph.agent_runs
    .filter((r) => r.task_id === task.id && !r.deleted_at)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, RECENT_RUNS);

  return (
    <div className="fixed inset-0 z-40">
      <div
        aria-hidden
        onClick={onClose}
        className={[
          "absolute inset-0 bg-slate-900/30 transition-opacity duration-200 motion-reduce:transition-none",
          entered ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        style={{ overscrollBehavior: "contain" }}
        className={[
          "absolute inset-y-0 right-0 flex w-full flex-col overflow-y-auto bg-white shadow-xl sm:w-[28rem]",
          "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
          entered ? "translate-x-0 opacity-100" : "translate-x-full opacity-0 motion-reduce:translate-x-0",
        ].join(" ")}
      >
        <header className="flex items-start gap-3 px-5 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              {ref && (
                <span translate="no" className="font-mono text-xs font-semibold text-slate-400">
                  {ref}
                </span>
              )}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[task.status]}`}
              >
                {STATUS_LABEL[task.status]}
              </span>
            </div>
            <h2
              id={titleId}
              className="break-words text-base font-semibold leading-snug text-slate-900 [text-wrap:pretty]"
            >
              <InlineCodeText text={task.title} />
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close task details"
            onClick={onClose}
            className={[
              "-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500",
              "transition-colors hover:bg-slate-100 hover:text-slate-900",
              FOCUS_RING,
            ].join(" ")}
          >
            <CloseIcon />
          </button>
        </header>

        <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2.5 px-5 pb-4 text-sm">
          <dt className="text-slate-500">Assignee</dt>
          <dd className="min-w-0">
            {renderAssignee ? (
              renderAssignee(task)
            ) : (
              <span className="text-slate-700">{memberLabel(members, task.assigned_user_id)}</span>
            )}
          </dd>
          {renderMove && (
            <>
              <dt className="text-slate-500">Status</dt>
              <dd className="min-w-0">{renderMove(task)}</dd>
            </>
          )}
          <dt className="text-slate-500">Sprint</dt>
          <dd className="min-w-0 text-slate-700">{task.sprint ?? "—"}</dd>
          {task.assignee && (
            <>
              <dt className="text-slate-500">Tracker</dt>
              <dd className="min-w-0 truncate text-slate-700" title="Assignee in the connected tracker">
                @{task.assignee}
              </dd>
            </>
          )}
          {task.updated_at && (
            <>
              <dt className="text-slate-500">Updated</dt>
              <dd className="min-w-0 text-slate-700">
                <TimeStamp iso={task.updated_at} />
              </dd>
            </>
          )}
        </dl>

        <Section
          title={`Acceptance Criteria${criteria.length > 0 ? ` (${criteria.length})` : ""}`}
        >
          {criteria.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
              {criteria.map((c, i) => (
                <li key={i} className="break-words">
                  {c.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No acceptance criteria</p>
          )}
        </Section>

        {task.spec_id && (
          <Section title="Spec">
            {spec ? (
              <p className="text-sm text-slate-700">
                <span className="break-words">{specLabel(graph, spec.id)}</span>
                <span className="ml-2 text-xs text-slate-400">
                  v{spec.version} · {spec.status === "approved" ? "Approved" : "Draft"}
                </span>
              </p>
            ) : (
              <p className="text-sm text-slate-400">Spec not found in this project</p>
            )}
          </Section>
        )}

        <Section title="Artifacts">
          {artifacts.length > 0 ? (
            <ul className="space-y-1.5">
              {artifacts.map((a) => (
                <ArtifactRow key={a.id} artifact={a} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No artifacts yet</p>
          )}
        </Section>

        {runs.length > 0 && (
          <Section title="Recent Agent Runs">
            <ul className="space-y-1.5">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </ul>
          </Section>
        )}

        <footer className="mt-auto border-t border-slate-100 px-5 py-3">
          <CopyLinkButton />
        </footer>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
