import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardUrlState } from "./useBoardUrlState";

const nav = { query: "", pathname: "/projects/p1" };

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => nav.pathname,
}));

/** Points both the rendered query and the address bar at `query`. */
function at(query: string) {
  nav.query = query;
  window.history.replaceState(null, "", query ? `${nav.pathname}?${query}` : nav.pathname);
}

function url(): string {
  return `${window.location.pathname}${window.location.search}`;
}

beforeEach(() => {
  at("");
});

describe("useBoardUrlState", () => {
  it("parses filters and the open task from the URL", () => {
    at("tab=tasks&q=login&assignee=me&group=sprint&task=t1");
    const { result } = renderHook(() => useBoardUrlState());
    expect(result.current.filters).toEqual({
      q: "login",
      assignee: "me",
      sprint: null,
      spec: null,
      group: "sprint",
      hideEmpty: false,
    });
    expect(result.current.openTaskId).toBe("t1");
  });

  it("merges a partial update and preserves unknown params", () => {
    at("tab=tasks&q=login");
    const { result } = renderHook(() => useBoardUrlState());
    result.current.setFilters({ assignee: "unassigned" });
    expect(url()).toBe("/projects/p1?tab=tasks&q=login&assignee=unassigned");
  });

  it("clears filters but keeps the grouping and hidden empty columns", () => {
    at("tab=tasks&q=x&sprint=S1&group=assignee&empty=hide");
    const { result } = renderHook(() => useBoardUrlState());
    result.current.clearFilters();
    expect(url()).toBe("/projects/p1?tab=tasks&group=assignee&empty=hide");
  });

  it("opens and closes a task", () => {
    at("tab=tasks");
    const { result, rerender } = renderHook(() => useBoardUrlState());
    result.current.openTask("t7");
    expect(url()).toBe("/projects/p1?tab=tasks&task=t7");

    nav.query = "tab=tasks&task=t7";
    rerender();
    expect(result.current.openTaskId).toBe("t7");
    result.current.closeTask();
    expect(url()).toBe("/projects/p1?tab=tasks");
  });

  it("drops the query string entirely when nothing is left", () => {
    at("q=x");
    const { result } = renderHook(() => useBoardUrlState());
    result.current.setFilters({ q: "" });
    expect(url()).toBe("/projects/p1");
  });

  it("keeps both of two writes made in one tick, before any re-render", () => {
    at("tab=tasks&task=gone");
    const { result } = renderHook(() => useBoardUrlState());
    // Same render, same callbacks: the second must not rebuild from the
    // query the first one already replaced.
    result.current.closeTask();
    result.current.setFilters({ assignee: "me" });
    expect(url()).toBe("/projects/p1?tab=tasks&assignee=me");

    result.current.setFilters({ sprint: "S1" });
    expect(url()).toBe("/projects/p1?tab=tasks&assignee=me&sprint=S1");
  });
});
