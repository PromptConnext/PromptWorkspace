import { describe, expect, it } from "vitest";
import { sortTasks, taskRefLabel } from "./taskOrder";
import type { Task } from "./types";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    project_id: "p1",
    spec_id: null,
    title: "A task",
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

describe("sortTasks", () => {
  it("orders by the Spec Kit reference, not by the wire order", () => {
    const sorted = sortTasks([
      task({ id: "c", feature_tag: "T003" }),
      task({ id: "a", feature_tag: "T001" }),
      task({ id: "b", feature_tag: "T002 [P]" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("compares the reference numerically, so T2 precedes T10", () => {
    const sorted = sortTasks([
      task({ id: "ten", feature_tag: "T010" }),
      task({ id: "two", feature_tag: "T2" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["two", "ten"]);
  });

  it("is unchanged by an updated_at bump — the assignment-reorder bug", () => {
    const before = [
      task({ id: "a", feature_tag: "T001", updated_at: "2026-08-01T00:00:00Z" }),
      task({ id: "b", feature_tag: "T002", updated_at: "2026-08-01T00:00:00Z" }),
      task({ id: "c", feature_tag: "T003", updated_at: "2026-08-01T00:00:00Z" }),
    ];
    // What the server does on assign: the row is rewritten and, because the
    // graph pull sorts by (updated_at, id), it comes back last.
    const touched = before[0];
    const after = [
      before[1],
      before[2],
      { ...touched, assigned_user_id: "u9", updated_at: "2026-08-09T12:00:00Z" },
    ];
    expect(sortTasks(after).map((t) => t.id)).toEqual(sortTasks(before).map((t) => t.id));
  });

  it("sorts tags that carry no reference after the ones that do", () => {
    const sorted = sortTasks([
      task({ id: "free", feature_tag: "billing-epic" }),
      task({ id: "none", feature_tag: null }),
      task({ id: "ref", feature_tag: "T007" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["ref", "free", "none"]);
  });

  it("falls back to id so equal keys still have one fixed order", () => {
    const a = task({ id: "a2", feature_tag: "T001" });
    const b = task({ id: "a1", feature_tag: "T001" });
    expect(sortTasks([a, b]).map((t) => t.id)).toEqual(["a1", "a2"]);
    expect(sortTasks([b, a]).map((t) => t.id)).toEqual(["a1", "a2"]);
  });

  it("does not mutate its input", () => {
    const input = [task({ id: "b", feature_tag: "T002" }), task({ id: "a", feature_tag: "T001" })];
    sortTasks(input);
    expect(input.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("taskRefLabel", () => {
  it("prints the reference as written and drops the parallel marker", () => {
    expect(taskRefLabel(task({ id: "x", feature_tag: "T004 [P]" }))).toBe("T004");
    expect(taskRefLabel(task({ id: "x", feature_tag: "T4" }))).toBe("T4");
  });

  it("returns null for a tag that is not a reference", () => {
    expect(taskRefLabel(task({ id: "x", feature_tag: "billing-epic" }))).toBeNull();
    expect(taskRefLabel(task({ id: "x", feature_tag: null }))).toBeNull();
  });
});
