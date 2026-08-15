"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { sortTasks } from "@/lib/taskOrder";
import type { Task } from "@/lib/types";

/**
 * The board's local view of the task list: server rows with in-flight and
 * just-saved edits layered on top.
 *
 * The board writes optimistically and does *not* refetch the graph afterwards,
 * for two reasons. A refetch costs a round trip the user watches the card sit
 * still through, and — worse — the pulled graph is ordered by `updated_at`, so
 * the round trip is also what used to fling the edited card to the bottom of
 * its column.
 *
 * That leaves this hook holding a row the parent's `graph` prop doesn't know
 * about yet. Reconciliation is by `updated_at`: an override survives until the
 * server's copy of that row is at least as new, at which point the override is
 * redundant and the server row is authoritative again (it may carry somebody
 * else's later edit). An override still in flight carries `updated_at: null`
 * and always wins, because nothing has been written yet to compare against.
 */

export interface TaskMutation {
  /** The optimistic shape to show immediately. */
  patch: Partial<Task>;
  /** The write. Resolves with the server's authoritative row. */
  request: () => Promise<Task>;
  /** Called with the failure so the caller can raise a toast and offer Retry. */
  onError?: (error: Error) => void;
}

export interface OptimisticTasks {
  /** Server rows, overrides applied, in stable display order. */
  tasks: Task[];
  /** Task ids with a write in flight — for a non-blocking saving cue. */
  savingIds: ReadonlySet<string>;
  mutate: (task: Task, mutation: TaskMutation) => Promise<void>;
}

export function useOptimisticTasks(serverTasks: Task[]): OptimisticTasks {
  const [overrides, setOverrides] = useState<Record<string, Task>>({});
  const [saving, setSaving] = useState<string[]>([]);
  // setState is async and a rollback needs the value from before *this* write,
  // so the ref is the read path and state is only the render path.
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  const tasks = useMemo(() => {
    const merged = serverTasks.map((row) => {
      const local = overrides[row.id];
      if (!local) return row;
      const settled = local.updated_at !== null;
      // Strictly newer, not newer-or-equal: a settled override *is* the server's
      // own response, so a row with the same timestamp carries no later news and
      // handing back the parent's staler copy would undo the edit on screen.
      if (settled && row.updated_at !== null && row.updated_at > local.updated_at!) return row;
      return local;
    });
    return sortTasks(merged);
  }, [serverTasks, overrides]);

  const mutate = useCallback(async (task: Task, { patch, request, onError }: TaskMutation) => {
    const previous = overridesRef.current[task.id];
    const optimistic: Task = { ...task, ...patch, updated_at: null };
    setOverrides((current) => ({ ...current, [task.id]: optimistic }));
    setSaving((current) => [...current, task.id]);
    try {
      const saved = await request();
      setOverrides((current) => ({ ...current, [task.id]: saved }));
    } catch (err) {
      setOverrides((current) => {
        const next = { ...current };
        // Restore what was showing before, which is not always "nothing":
        // a second edit can land while an earlier one is still settling.
        if (previous) next[task.id] = previous;
        else delete next[task.id];
        return next;
      });
      onError?.(err as Error);
    } finally {
      // Splice one occurrence — concurrent writes to the same card each own one.
      setSaving((current) => {
        const at = current.indexOf(task.id);
        return at < 0 ? current : [...current.slice(0, at), ...current.slice(at + 1)];
      });
    }
  }, []);

  const savingIds = useMemo(() => new Set(saving), [saving]);

  return { tasks, savingIds, mutate };
}
