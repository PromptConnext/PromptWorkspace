"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { EMPTY_FILTERS, parseBoardFilters, writeBoardFilters } from "@/lib/boardFilters";
import type { BoardFilters } from "@/lib/boardFilters";

/**
 * The board's filters and open task, read from and written to the URL.
 *
 * Writes use `replace`, not `push`: narrowing a board is not navigation, and
 * a back button that steps through every keystroke of a search is a trap. The
 * scroll position is kept for the same reason — the board did not change
 * pages. Debouncing typed search is the toolbar's job; this hook writes
 * whatever it is handed, immediately.
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
  const router = useRouter();

  // useSearchParams returns a fresh read-only object per navigation, so its
  // string form is the stable thing to memoise on.
  const query = searchParams.toString();
  const filters = useMemo(() => parseBoardFilters(new URLSearchParams(query)), [query]);
  const openTaskId = new URLSearchParams(query).get("task") || null;

  const replace = useCallback(
    (params: URLSearchParams) => {
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const setFilters = useCallback(
    (next: Partial<BoardFilters>) => {
      replace(writeBoardFilters(new URLSearchParams(query), { ...filters, ...next }));
    },
    [replace, query, filters],
  );

  // Clears what narrows the list; the grouping is a layout choice and stays.
  const clearFilters = useCallback(() => {
    replace(
      writeBoardFilters(new URLSearchParams(query), { ...EMPTY_FILTERS, group: filters.group }),
    );
  }, [replace, query, filters.group]);

  const openTask = useCallback(
    (id: string) => {
      const params = new URLSearchParams(query);
      params.set("task", id);
      replace(params);
    },
    [replace, query],
  );

  const closeTask = useCallback(() => {
    const params = new URLSearchParams(query);
    params.delete("task");
    replace(params);
  }, [replace, query]);

  return { filters, setFilters, clearFilters, openTaskId, openTask, closeTask };
}
