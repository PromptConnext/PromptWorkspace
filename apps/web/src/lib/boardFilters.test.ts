import { describe, expect, it } from "vitest";
import {
  applyBoardFilters,
  EMPTY_FILTERS,
  EMPTY_GROUP_KEY,
  groupBoardTasks,
  hasActiveFilters,
  parseBoardFilters,
  writeBoardFilters,
} from "./boardFilters";
import type { BoardFilters } from "./boardFilters";
import type { Task } from "./types";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    project_id: "p1",
    spec_id: null,
    title: `Task ${overrides.id}`,
    status: "todo",
    feature_tag: null,
    acceptance_criteria: [],
    assignee: null,
    sprint: null,
    assigned_user_id: null,
    updated_at: "2026-08-01T00:00:00Z",
    deleted_at: null,
    field_versions: {},
    ...overrides,
  };
}

const ctx = {
  memberLabel: (id: string | null) => (id ? `member-${id}` : "Unassigned"),
  specLabel: (id: string | null) => (id ? `spec-${id}` : "No spec"),
};

describe("parseBoardFilters / writeBoardFilters", () => {
  it("parses an empty query as the empty filters", () => {
    expect(parseBoardFilters(new URLSearchParams(""))).toEqual(EMPTY_FILTERS);
  });

  it("roundtrips every field and keeps unknown params", () => {
    const f: BoardFilters = {
      q: "login",
      assignee: "me",
      sprint: "Sprint 3",
      spec: "s1",
      group: "sprint",
      hideEmpty: true,
    };
    const written = writeBoardFilters(new URLSearchParams("tab=tasks&task=t9"), f);
    expect(written.get("tab")).toBe("tasks");
    expect(written.get("task")).toBe("t9");
    expect(parseBoardFilters(written)).toEqual(f);
  });

  it("deletes defaults instead of writing them", () => {
    const start = new URLSearchParams("tab=tasks&q=x&assignee=me&sprint=S1&spec=s1&group=spec&empty=hide");
    const written = writeBoardFilters(start, { ...EMPTY_FILTERS, q: "   " });
    expect(written.toString()).toBe("tab=tasks");
  });

  it("returns a copy rather than mutating its input", () => {
    const start = new URLSearchParams("tab=tasks");
    writeBoardFilters(start, { ...EMPTY_FILTERS, q: "x" });
    expect(start.toString()).toBe("tab=tasks");
  });

  it("falls back to no grouping for an unknown group value", () => {
    expect(parseBoardFilters(new URLSearchParams("group=priority")).group).toBe("none");
  });
});

describe("hasActiveFilters", () => {
  it("ignores grouping and whitespace-only search", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, group: "assignee", q: "  " })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, group: "assignee", hideEmpty: true })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, spec: "s1" })).toBe(true);
  });
});

describe("applyBoardFilters", () => {
  const tasks = [
    task({ id: "a", title: "Build Login Form", feature_tag: "T001", assigned_user_id: "u1" }),
    task({
      id: "b",
      title: "Write docs",
      feature_tag: "T002 [P]",
      acceptance_criteria: [{ text: "Covers OAuth callback" }],
      assigned_user_id: "u2",
      sprint: "S1",
      spec_id: "s1",
    }),
    task({ id: "c", title: "Ship it", sprint: "S2" }),
  ];
  const ids = (f: Partial<BoardFilters>, viewer = "u1") =>
    applyBoardFilters(tasks, { ...EMPTY_FILTERS, ...f }, viewer).map((t) => t.id);

  it("matches title, reference and acceptance criteria, case-insensitive and trimmed", () => {
    expect(ids({ q: "  login " })).toEqual(["a"]);
    expect(ids({ q: "t002" })).toEqual(["b"]);
    expect(ids({ q: "oauth" })).toEqual(["b"]);
    expect(ids({ q: "" })).toEqual(["a", "b", "c"]);
  });

  it("matches a title with inline code both raw and as displayed", () => {
    const coded = [task({ id: "k", title: "Create `src/consent/`, `src/auth/` folders" })];
    const q = (needle: string) =>
      applyBoardFilters(coded, { ...EMPTY_FILTERS, q: needle }, "u1").map((t) => t.id);
    expect(q("`src/auth/`")).toEqual(["k"]);
    expect(q("src/consent/, src/auth/")).toEqual(["k"]);
  });

  it("filters by me, unassigned and a specific member", () => {
    expect(ids({ assignee: "me" }, "u1")).toEqual(["a"]);
    expect(ids({ assignee: "me" }, "")).toEqual([]);
    expect(ids({ assignee: "unassigned" })).toEqual(["c"]);
    expect(ids({ assignee: "u2" })).toEqual(["b"]);
  });

  it("filters by sprint and spec, combined with AND", () => {
    expect(ids({ sprint: "S2" })).toEqual(["c"]);
    expect(ids({ spec: "s1" })).toEqual(["b"]);
    expect(ids({ sprint: "S1", assignee: "me" })).toEqual([]);
  });

  it("matches a sprint padded with whitespace to its trimmed option", () => {
    const padded = [task({ id: "p", sprint: " Sprint 2 " }), task({ id: "q", sprint: "Sprint 2" })];
    const matched = applyBoardFilters(padded, { ...EMPTY_FILTERS, sprint: "Sprint 2" }, "u1");
    expect(matched.map((t) => t.id)).toEqual(["p", "q"]);
  });
});

describe("groupBoardTasks", () => {
  it("returns one group for none", () => {
    const tasks = [task({ id: "a" })];
    expect(groupBoardTasks(tasks, "none", ctx)).toEqual([
      { key: "all", label: "All Tasks", tasks },
    ]);
  });

  it("orders sprint groups numerically with the empty group last", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", sprint: "Sprint 10" }),
      task({ id: "c", sprint: "Sprint 2" }),
      task({ id: "d", sprint: "Sprint 10" }),
    ];
    const groups = groupBoardTasks(tasks, "sprint", ctx);
    expect(groups.map((g) => g.label)).toEqual(["Sprint 2", "Sprint 10", "No sprint"]);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(["b", "d"]);
    expect(groups[2].key).toBe(EMPTY_GROUP_KEY);
  });

  it("puts padded and blank sprints in the same lanes as their trimmed values", () => {
    const tasks = [
      task({ id: "a", sprint: "Sprint 2 " }),
      task({ id: "b", sprint: "Sprint 2" }),
      task({ id: "c", sprint: "   " }),
    ];
    const groups = groupBoardTasks(tasks, "sprint", ctx);
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ["Sprint 2", ["a", "b"]],
      [EMPTY_GROUP_KEY, ["c"]],
    ]);
  });

  it("labels assignee and spec groups through the context", () => {
    const tasks = [
      task({ id: "a", assigned_user_id: "zed", spec_id: "s2" }),
      task({ id: "b" }),
      task({ id: "c", assigned_user_id: "amy", spec_id: "s1" }),
    ];
    expect(groupBoardTasks(tasks, "assignee", ctx).map((g) => g.label)).toEqual([
      "member-amy",
      "member-zed",
      "Unassigned",
    ]);
    expect(groupBoardTasks(tasks, "spec", ctx).map((g) => [g.key, g.label])).toEqual([
      ["s1", "spec-s1"],
      ["s2", "spec-s2"],
      [EMPTY_GROUP_KEY, "No spec"],
    ]);
  });
});
