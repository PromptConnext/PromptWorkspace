"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { hasActiveFilters } from "@/lib/boardFilters";
import type { BoardFilters, BoardGroup } from "@/lib/boardFilters";
import type { WorkspaceMember } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { memberFullName, memberShortName } from "./MemberChip";

/**
 * Search, filter and grouping controls above the task board.
 *
 * Every picker needs an "everyone / every sprint" entry, and Radix refuses
 * `value=""` on an item (see components/ui/Select.tsx), so "no filter" is a
 * sentinel mapped back to null at the onChange boundary.
 */
const ALL = "__all__";

// Typing stays instant in the input; only the URL write (and with it the
// board re-filter) waits for a pause.
const SEARCH_DEBOUNCE_MS = 200;

const GROUP_OPTIONS: { value: BoardGroup; label: string }[] = [
  { value: "none", label: "None" },
  { value: "assignee", label: "Assignee" },
  { value: "sprint", label: "Sprint" },
  { value: "spec", label: "Spec" },
];

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1";

export function BoardToolbar({
  filters,
  onChange,
  onClear,
  members,
  sprints,
  specs,
  viewerId,
  resultCount,
  totalCount,
  searchInputRef,
}: {
  filters: BoardFilters;
  onChange: (next: Partial<BoardFilters>) => void;
  onClear: () => void;
  members: WorkspaceMember[];
  sprints: string[];
  specs: { id: string; label: string }[];
  viewerId: string;
  resultCount: number;
  totalCount: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState(filters.q);
  // The last value this toolbar wrote. A q arriving from outside (Clear
  // Filters, back button, a pasted link) differs from it and resets the input;
  // our own write echoing back through the URL does not.
  const sent = useRef(filters.q);
  // The debounce timer must not restart whenever the parent re-renders with a
  // new callback identity, so it reads the latest one through a ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (filters.q === sent.current) return;
    sent.current = filters.q;
    setText(filters.q);
  }, [filters.q]);

  useEffect(() => {
    if (text === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = text;
      onChangeRef.current({ q: text });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const mine = filters.assignee === "me";
  const active = hasActiveFilters(filters);

  const assigneeLabel =
    filters.assignee === null
      ? "All"
      : filters.assignee === "me"
        ? "Me"
        : filters.assignee === "unassigned"
          ? "Unassigned"
          : memberShortName(members.find((m) => m.user_id === filters.assignee));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1 basis-56">
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Search tasks"
          aria-keyshortcuts="/"
          title="Search tasks (/)"
          placeholder="Search tasks…"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || text === "") return;
            // Handled here, so a board-level Esc (closing a drawer, say) does
            // not also fire for the same key press.
            e.preventDefault();
            e.stopPropagation();
            setText("");
            sent.current = "";
            onChange({ q: "" });
          }}
          className={[
            "h-9 w-full rounded-lg border border-slate-300 bg-white pl-8 pr-8 text-sm text-slate-700 shadow-sm",
            "placeholder:text-slate-400 transition-colors hover:border-slate-400",
            "focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200",
          ].join(" ")}
        />
        {/* The shortcut, where people look for it; it steps aside once there
            is text, which is also where the browser puts its clear button. */}
        {text === "" && (
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-slate-200 px-1 font-sans text-[10px] leading-4 text-slate-400"
          >
            /
          </kbd>
        )}
      </div>

      <button
        type="button"
        aria-pressed={mine}
        aria-keyshortcuts="m"
        title="Show only tasks assigned to you (M)"
        onClick={() => onChange({ assignee: mine ? null : "me" })}
        className={[
          "h-9 rounded-lg border px-3 text-sm font-medium shadow-sm transition-colors",
          mine
            ? "border-slate-800 bg-slate-800 text-white hover:bg-slate-700"
            : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50",
          FOCUS_RING,
        ].join(" ")}
      >
        My Tasks
      </button>

      <Select
        value={filters.assignee ?? ALL}
        onValueChange={(next) => onChange({ assignee: next === ALL ? null : next })}
      >
        <SelectTrigger aria-label="Assignee" className="max-w-[14rem]">
          <span className="text-slate-400">Assignee</span>
          <SelectValue>
            <span className="truncate">{assigneeLabel}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {viewerId && <SelectItem value="me">Me</SelectItem>}
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user_id} value={m.user_id} title={memberFullName(m)}>
              {memberShortName(m)}
              {m.email && <span className="ml-2 text-xs text-slate-400">{m.email}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {sprints.length > 0 && (
        <Select
          value={filters.sprint ?? ALL}
          onValueChange={(next) => onChange({ sprint: next === ALL ? null : next })}
        >
          <SelectTrigger aria-label="Sprint" className="max-w-[14rem]">
            <span className="text-slate-400">Sprint</span>
            <SelectValue>
              <span className="truncate">{filters.sprint ?? "All"}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            {sprints.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {specs.length > 0 && (
        <Select
          value={filters.spec ?? ALL}
          onValueChange={(next) => onChange({ spec: next === ALL ? null : next })}
        >
          <SelectTrigger aria-label="Spec" className="max-w-[16rem]">
            <span className="text-slate-400">Spec</span>
            <SelectValue>
              <span className="truncate">
                {filters.spec === null
                  ? "All"
                  : (specs.find((s) => s.id === filters.spec)?.label ?? filters.spec)}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            {specs.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={filters.group} onValueChange={(next) => onChange({ group: next as BoardGroup })}>
        <SelectTrigger aria-label="Group By">
          <span className="text-slate-400">Group By</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GROUP_OPTIONS.map((g) => (
            <SelectItem key={g.value} value={g.value}>
              {g.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {filters.group !== "none" && (
        <button
          type="button"
          aria-pressed={filters.hideEmpty}
          title="Hide columns a swimlane has no tasks in"
          onClick={() => onChange({ hideEmpty: !filters.hideEmpty })}
          className={[
            "h-9 rounded-lg border px-3 text-sm font-medium shadow-sm transition-colors",
            filters.hideEmpty
              ? "border-slate-800 bg-slate-800 text-white hover:bg-slate-700"
              : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50",
            FOCUS_RING,
          ].join(" ")}
        >
          Hide Empty Columns
        </button>
      )}

      {active && (
        <button
          type="button"
          onClick={onClear}
          className={[
            "h-9 rounded-lg px-2.5 text-sm font-medium text-slate-600 transition-colors",
            "hover:bg-slate-100 hover:text-slate-900",
            FOCUS_RING,
          ].join(" ")}
        >
          Clear Filters
        </button>
      )}

      <p aria-live="polite" className="ml-auto text-xs tabular-nums text-slate-500">
        {active
          ? `Showing ${resultCount} of ${totalCount} ${totalCount === 1 ? "task" : "tasks"}`
          : `${totalCount} ${totalCount === 1 ? "task" : "tasks"}`}
      </p>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}
