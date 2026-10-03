import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardUrlState } from "./useBoardUrlState";

const nav = { query: "", pathname: "/projects/p1" };
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace }),
}));

beforeEach(() => {
  replace.mockReset();
  nav.query = "";
});

describe("useBoardUrlState", () => {
  it("parses filters and the open task from the URL", () => {
    nav.query = "tab=tasks&q=login&assignee=me&group=sprint&task=t1";
    const { result } = renderHook(() => useBoardUrlState());
    expect(result.current.filters).toEqual({
      q: "login",
      assignee: "me",
      sprint: null,
      spec: null,
      group: "sprint",
    });
    expect(result.current.openTaskId).toBe("t1");
  });

  it("merges a partial update and preserves unknown params", () => {
    nav.query = "tab=tasks&q=login";
    const { result } = renderHook(() => useBoardUrlState());
    result.current.setFilters({ assignee: "unassigned" });
    expect(replace).toHaveBeenCalledWith("/projects/p1?tab=tasks&q=login&assignee=unassigned", {
      scroll: false,
    });
  });

  it("clears filters but keeps the grouping", () => {
    nav.query = "tab=tasks&q=x&sprint=S1&group=assignee";
    const { result } = renderHook(() => useBoardUrlState());
    result.current.clearFilters();
    expect(replace).toHaveBeenCalledWith("/projects/p1?tab=tasks&group=assignee", {
      scroll: false,
    });
  });

  it("opens and closes a task", () => {
    nav.query = "tab=tasks";
    const { result, rerender } = renderHook(() => useBoardUrlState());
    result.current.openTask("t7");
    expect(replace).toHaveBeenLastCalledWith("/projects/p1?tab=tasks&task=t7", { scroll: false });

    nav.query = "tab=tasks&task=t7";
    rerender();
    expect(result.current.openTaskId).toBe("t7");
    result.current.closeTask();
    expect(replace).toHaveBeenLastCalledWith("/projects/p1?tab=tasks", { scroll: false });
  });

  it("drops the query string entirely when nothing is left", () => {
    nav.query = "q=x";
    const { result } = renderHook(() => useBoardUrlState());
    result.current.setFilters({ q: "" });
    expect(replace).toHaveBeenCalledWith("/projects/p1", { scroll: false });
  });
});
