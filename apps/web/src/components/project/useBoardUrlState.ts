"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { EMPTY_FILTERS, parseBoardFilters, writeBoardFilters } from "@/lib/boardFilters";
import type { BoardFilters } from "@/lib/boardFilters";

/**
 * The board's filters and open task, read from and written to the URL.
 *
 * Writes replace the history entry rather than push one: narrowing a board is
 * not navigation, and a back button that steps through every keystroke of a
 * search is a trap. The scroll position is kept for the same reason — the
 * board did not change pages. Debouncing typed search is the toolbar's job;
 * this hook writes whatever it is handed, immediately.
 *
 * Each write starts from the live address bar, not the query this render
 * read, and lands synchronously through `history.replaceState` (which Next
 * folds back into `useSearchParams`). Two writes in one tick — closing a
 * stale task link while a filter changes — therefore compose instead of the
 * second quietly undoing the first.
 */
export function useBoardUrlState(): {
  filters: BoardFilters;
  setFilters: (next: Partial<BoardFilters>) => void;
  clearFilters: () => void;
  openTaskId: string | null;
  openTask: (id: string) => void;
  closeTask: () => void;
} {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // useSearchParams returns a fresh read-only object per navigation, so its
  // string form is the stable thing to memoise on.
  const query = searchParams.toString();
  const filters = useMemo(() => parseBoardFilters(new URLSearchParams(query)), [query]);
  const openTaskId = new URLSearchParams(query).get("task") || null;

  const update = useCallback(
    (edit: (current: URLSearchParams) => URLSearchParams) => {
      const qs = edit(new URLSearchParams(window.location.search)).toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname],
  );

  const setFilters = useCallback(
    (next: Partial<BoardFilters>) => {
      update((current) =>
        writeBoardFilters(current, { ...parseBoardFilters(current), ...next }),
      );
    },
    [update],
  );

  // Clears what narrows the list; the grouping is a layout choice and stays.
  const clearFilters = useCallback(() => {
    update((current) =>
      writeBoardFilters(current, { ...EMPTY_FILTERS, group: parseBoardFilters(current).group }),
    );
  }, [update]);

  const openTask = useCallback(
    (id: string) => {
      update((current) => {
        current.set("task", id);
        return current;
      });
    },
    [update],
  );

  const closeTask = useCallback(() => {
    update((current) => {
      current.delete("task");
      return current;
    });
  }, [update]);

  return { filters, setFilters, clearFilters, openTaskId, openTask, closeTask };
}
