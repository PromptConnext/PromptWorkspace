"use client";

import { useDraggable } from "@dnd-kit/core";
import { useMemo } from "react";
import { authorityOf } from "@/lib/fieldAuthority";
import { taskRefLabel } from "@/lib/taskOrder";
import type { Artifact, Task, TaskStatus, WorkspaceMember } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { MemberChip, memberFullName, memberShortName } from "./MemberChip";
import { COLUMNS, COLUMN_STATUSES, taskName } from "./taskBoardA11y";
import {
  assignableUserIds,
  canAssign,
  canMoveAnywhere,
  canMoveTo,
  isAdmin,
  moveDeniedReason,
} from "./taskPermissions";
import type { Viewer } from "./taskPermissions";

/**
 * Unassigning is a choice the user makes, not the absence of one, so it has to
 * be a real item in the list. Radix refuses `value=""` on an item (it reserves
 * the empty string for "nothing selected"), hence a sentinel that
 * `onValueChange` maps back to the null the assign endpoint expects.
 */
const UNASSIGNED = "__unassigned__";

const AUTHORITY_STYLE: Record<string, string> = {
  pz: "bg-indigo-100 text-indigo-700",
  pmo: "bg-amber-100 text-amber-800",
  shared: "bg-slate-100 text-slate-700",
};

/**
 * Field ownership (ADR 0010) is worth surfacing — it explains why a value
 * can't be edited here — but "· pmo" is internal vocabulary. Carry the
 * meaning in colour plus a hover title instead of printing the domain name
 * at a business stakeholder.
 */
const AUTHORITY_HINT: Record<string, string> = {
  pz: "Managed in PromptWorkspace",
  pmo: "Managed by the connected project tracker (Jira / ClickUp)",
  shared: "Editable in PromptWorkspace and the connected tracker",
};

function authorityHint(field: string): string {
  return AUTHORITY_HINT[authorityOf("tasks", field)];
}

function authorityClass(field: string): string {
  return `rounded px-1.5 py-0.5 text-[11px] ${AUTHORITY_STYLE[authorityOf("tasks", field)]}`;
}

const ICON_BUTTON =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition-colors " +
  "hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

/**
 * The tracker's free-text `assignee` and our member `assigned_user_id` usually
 * name the same person. Printing both reads as two owners; the member is the
 * one this board edits, so the tracker's only earns a badge when it disagrees.
 */
function trackerDiffers(tracker: string | null, owner: WorkspaceMember | undefined): boolean {
  if (!tracker) return false;
  if (!owner?.email) return true;
  const t = tracker.replace(/^@/, "").trim().toLowerCase();
  const email = owner.email.toLowerCase();
  return t !== email && t !== email.slice(0, email.indexOf("@"));
}

export function AssigneeControl({
  task,
  members,
  owner,
  viewer,
  readOnly,
  onAssign,
}: {
  task: Task;
  members: WorkspaceMember[];
  owner: WorkspaceMember | undefined;
  viewer: Viewer;
  readOnly: boolean;
  onAssign: (task: Task, next: string | null) => void;
}) {
  const ref = taskRefLabel(task) ?? task.title;
  const allowed = useMemo(
    () => new Set(assignableUserIds(viewer, members.map((m) => m.user_id))),
    [viewer, members],
  );

  if (readOnly || !canAssign(task, viewer)) {
    if (!task.assigned_user_id) return <span className="text-xs text-slate-600">Unassigned</span>;
    return (
      <MemberChip
        member={owner}
        title={`${authorityHint("assigned_user_id")} — assigned to ${memberFullName(owner)}`}
      />
    );
  }

  if (!isAdmin(viewer)) {
    // A member's only choices are "me" and "nobody", so a picker holding one
    // name is a detour. Offer the action itself.
    if (task.assigned_user_id === null) {
      return (
        <button
          type="button"
          onClick={() => onAssign(task, viewer.userId)}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Assign to Me<span className="sr-only">: {ref}</span>
        </button>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-1">
        <MemberChip member={owner} />
        <button
          type="button"
          aria-label={`Unassign me from ${ref}`}
          title="Unassign me"
          onClick={() => onAssign(task, null)}
          className={ICON_BUTTON}
        >
          <CloseIcon />
        </button>
      </span>
    );
  }

  const current = task.assigned_user_id ? memberFullName(owner) : "Unassigned";
  return (
    <Select
      value={task.assigned_user_id ?? UNASSIGNED}
      onValueChange={(next) => onAssign(task, next === UNASSIGNED ? null : next)}
    >
      <SelectTrigger
        aria-label={`Assignee for ${ref}`}
        size="sm"
        className="w-full min-w-0 overflow-hidden focus-visible:ring-blue-500"
        title={current}
      >
        <SelectValue>
          <span className="block w-full truncate text-left text-[11px]">
            {task.assigned_user_id ? memberShortName(owner) : "Unassigned"}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {members
          .filter((m) => allowed.has(m.user_id))
          .map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {memberFullName(m)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The keyboard and screen-reader path to the same move dragging performs. The
 * column already shows the current status, so this is a compact "Move to…"
 * trigger rather than a second copy of the status; illegal targets stay listed
 * but disabled, so the menu still explains the shape of the workflow.
 */
export function MoveMenu({
  task,
  viewer,
  onMove,
}: {
  task: Task;
  viewer: Viewer;
  onMove: (task: Task, next: TaskStatus) => void;
}) {
  const ref = taskRefLabel(task) ?? task.title;
  return (
    <Select value={task.status} onValueChange={(next) => onMove(task, next as TaskStatus)}>
      <SelectTrigger
        aria-label={`Move ${ref} to another column`}
        title="Move to…"
        size="sm"
        className="shrink-0 focus-visible:ring-blue-500"
      >
        <MoveIcon />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectLabel>Move to…</SelectLabel>
          {COLUMNS.map((c) => (
            <SelectItem
              key={c.status}
              value={c.status}
              disabled={c.status !== task.status && !canMoveTo(task, viewer, c.status)}
            >
              {c.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * A `title` alone is invisible on touch and to most screen readers, so the
 * reason a card won't move is also in the accessibility tree, next to a lock
 * that tells sighted users there *is* a reason.
 */
export function LockNote({ reason }: { reason: string }) {
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-slate-500" title={reason}>
      <LockIcon />
      <span className="sr-only">{reason}</span>
    </span>
  );
}

/** Artifact URIs come from the sync payload; only http(s) becomes a link. */
export function isHttpUrl(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function ArtifactLinks({ artifacts }: { artifacts: Artifact[] }) {
  const linkable = artifacts.filter((a) => !a.deleted_at && isHttpUrl(a.uri));
  if (linkable.length === 0) return null;
  const shown = linkable.slice(0, 2);
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-600">
      {shown.map((a) => {
        const label = a.commit_sha
          ? a.commit_sha.slice(0, 7)
          : /\/pull\/\d+|\/merge_requests\/\d+/.test(a.uri)
            ? "PR"
            : a.kind;
        return (
          <a
            key={a.id}
            href={a.uri}
            target="_blank"
            rel="noreferrer"
            translate="no"
            title={a.uri}
            className="rounded font-mono text-slate-700 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-slate-900 hover:decoration-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {a.commit_sha && <span className="sr-only">Commit </span>}
            {label}
          </a>
        );
      })}
      {linkable.length > shown.length && <span>+{linkable.length - shown.length}</span>}
    </span>
  );
}

export function CardBody({
  task,
  owner,
  dragging,
  saving,
  handle,
  onOpen,
}: {
  task: Task;
  owner?: WorkspaceMember;
  dragging?: boolean;
  saving?: boolean;
  /** The keyboard drag handle, rendered before the reference. */
  handle?: React.ReactNode;
  onOpen?: (task: Task) => void;
}) {
  const ref = taskRefLabel(task);
  const titleClass = "min-w-0 flex-1 break-words text-sm font-medium leading-snug text-slate-900";
  return (
    <>
      {/* A 2px bar, not a spinner: the write is optimistic, so the card is
          already showing the new value and must stay readable and clickable
          while it settles. */}
      <span
        aria-hidden
        className={`absolute inset-x-0 top-0 h-0.5 rounded-t bg-blue-400 transition-opacity ${
          saving ? "animate-pulse opacity-100 motion-reduce:animate-none" : "opacity-0"
        }`}
      />
      <div className="flex items-start gap-1.5">
        {handle}
        {ref && (
          <span className="mt-0.5 shrink-0 font-mono text-[11px] font-semibold text-slate-500">
            {ref}
          </span>
        )}
        {onOpen && !dragging ? (
          <button
            type="button"
            onClick={() => onOpen(task)}
            className={`${titleClass} rounded text-left transition-colors hover:text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
          >
            {task.title}
          </button>
        ) : (
          <p className={titleClass}>{task.title}</p>
        )}
      </div>
      {!dragging && (trackerDiffers(task.assignee, owner) || task.sprint) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {trackerDiffers(task.assignee, owner) && (
            <span className={authorityClass("assignee")} title={authorityHint("assignee")}>
              Tracker: {task.assignee}
            </span>
          )}
          {task.sprint && (
            <span className={authorityClass("sprint")} title={authorityHint("sprint")}>
              {task.sprint}
            </span>
          )}
        </div>
      )}
    </>
  );
}

export interface TaskCardProps {
  task: Task;
  members: WorkspaceMember[];
  viewer: Viewer;
  /** A write for this card is in flight. */
  saving?: boolean;
  /**
   * Members haven't loaded, so permissions can't be decided: render the card
   * for reading only — no drag, no assign, no move.
   */
  readOnly?: boolean;
  /** This task's artifacts from `graph.artifacts`. */
  artifacts?: Artifact[];
  onAssign: (task: Task, next: string | null) => void;
  onMove: (task: Task, next: TaskStatus) => void;
  /** When given, the title becomes a button that opens the task's details. */
  onOpen?: (task: Task) => void;
}

export function TaskCard({
  task,
  members,
  viewer,
  saving = false,
  readOnly = false,
  artifacts = [],
  onAssign,
  onMove,
  onOpen,
}: TaskCardProps) {
  const movable = canMoveAnywhere(task, viewer, COLUMN_STATUSES);
  const draggable = !readOnly && movable;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !draggable,
  });
  const owner = task.assigned_user_id
    ? members.find((m) => m.user_id === task.assigned_user_id)
    : undefined;
  const ref = taskRefLabel(task) ?? task.title;

  // The whole body drags under a mouse or finger, but keyboard focus lands on
  // a dedicated handle: the title may be a button of its own, and a button
  // nested in dnd-kit's role="button" is unreachable to assistive tech. Only
  // spread dnd-kit's attributes when the card can actually move — they carry
  // role="button" and tabIndex, and a focusable control that refuses every
  // key is worse than plain text.
  const handle = draggable ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      aria-roledescription="draggable task"
      aria-label={`Move task ${taskName(task)}`}
      className="-ml-1 mt-0.5 inline-flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 active:cursor-grabbing"
    >
      <GripIcon />
    </button>
  ) : null;

  return (
    <div
      ref={setNodeRef}
      className={[
        "relative touch-manipulation rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-shadow",
        // The card stays in place, greyed, while its clone follows the pointer —
        // a column that reflows mid-drag makes the drop target guesswork.
        isDragging ? "opacity-40" : "hover:shadow-md",
      ].join(" ")}
    >
      <div
        {...(draggable ? listeners : {})}
        title={readOnly || draggable ? undefined : moveDeniedReason(task, viewer)}
        className={draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"}
      >
        <CardBody task={task} owner={owner} saving={saving} handle={handle} onOpen={onOpen} />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {/* Who owns it is the field people scan and change most, so it takes
            the slack; moving is one compact trigger. */}
        <div className="flex min-w-0 flex-1 items-center">
          <AssigneeControl
            task={task}
            members={members}
            owner={owner}
            viewer={viewer}
            readOnly={readOnly}
            onAssign={onAssign}
          />
        </div>
        {!readOnly &&
          (movable ? (
            <MoveMenu task={task} viewer={viewer} onMove={onMove} />
          ) : (
            <LockNote reason={moveDeniedReason(task, viewer)} />
          ))}
      </div>
      {(task.acceptance_criteria.length > 0 || artifacts.length > 0) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-2 gap-y-1">
          {task.acceptance_criteria.length > 0 && (
            <details className="min-w-0 text-xs text-slate-600 open:basis-full">
              <summary className="cursor-pointer select-none rounded text-[11px] text-slate-600 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {task.acceptance_criteria.length} acceptance{" "}
                {task.acceptance_criteria.length === 1 ? "criterion" : "criteria"}
                <span className="sr-only"> for {ref}</span>
              </summary>
              <ul className="mt-1 list-outside list-disc break-words pl-4">
                {task.acceptance_criteria.map((c, i) => (
                  <li key={i}>{c.text}</li>
                ))}
              </ul>
            </details>
          )}
          <ArtifactLinks artifacts={artifacts} />
        </div>
      )}
    </div>
  );
}

function GripIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 8 14" className="h-3.5 w-2" fill="currentColor">
      <circle cx="2" cy="2" r="1" />
      <circle cx="6" cy="2" r="1" />
      <circle cx="2" cy="7" r="1" />
      <circle cx="6" cy="7" r="1" />
      <circle cx="2" cy="12" r="1" />
      <circle cx="6" cy="12" r="1" />
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
