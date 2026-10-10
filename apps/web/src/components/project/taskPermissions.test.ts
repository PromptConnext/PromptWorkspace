import { describe, expect, it } from "vitest";
import {
  assignableUserIds,
  canAssign,
  canMoveAnywhere,
  canMoveTo,
} from "./taskPermissions";
import type { Task, TaskStatus } from "@/lib/types";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "implemented", "verified"];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    spec_id: null,
    title: "A task",
    status: "todo",
    feature_tag: "T001",
    acceptance_criteria: [],
    assignee: null,
    sprint: null,
    assigned_user_id: null,
    change_id: null,
    updated_at: "2026-08-01T00:00:00Z",
    deleted_at: null,
    field_versions: {},
    ...overrides,
  };
}

const admin = { userId: "u1", role: "admin" };
const member = { userId: "u2", role: "member" };

// Each expectation below pairs with a branch of assign_task / set_task_status
// in apps/cloud/app/api/sync.py. If one of those rules moves, this file is the
// tripwire.
describe("canAssign", () => {
  it("lets an admin reassign anything", () => {
    expect(canAssign(task({ assigned_user_id: "u9" }), admin)).toBe(true);
  });

  it("lets a member claim an unassigned task or release their own", () => {
    expect(canAssign(task({ assigned_user_id: null }), member)).toBe(true);
    expect(canAssign(task({ assigned_user_id: "u2" }), member)).toBe(true);
  });

  it("refuses a member somebody else's task", () => {
    expect(canAssign(task({ assigned_user_id: "u9" }), member)).toBe(false);
  });
});

describe("assignableUserIds", () => {
  it("gives an admin every member", () => {
    expect(assignableUserIds(admin, ["u1", "u2", "u9"])).toEqual(["u1", "u2", "u9"]);
  });

  it("gives a member only themselves — the endpoint accepts nothing else", () => {
    expect(assignableUserIds(member, ["u1", "u2", "u9"])).toEqual(["u2"]);
  });
});

describe("canMoveTo", () => {
  it("lets an admin move any task anywhere, verified included", () => {
    for (const status of COLUMNS) {
      expect(canMoveTo(task({ assigned_user_id: "u9" }), admin, status)).toBe(true);
    }
  });

  it("lets a member advance their own task short of verified", () => {
    const held = task({ assigned_user_id: "u2" });
    expect(canMoveTo(held, member, "in_progress")).toBe(true);
    expect(canMoveTo(held, member, "implemented")).toBe(true);
    expect(canMoveTo(held, member, "verified")).toBe(false);
  });

  it("refuses a member a task they do not hold, unassigned included", () => {
    expect(canMoveTo(task({ assigned_user_id: "u9" }), member, "in_progress")).toBe(false);
    expect(canMoveTo(task({ assigned_user_id: null }), member, "in_progress")).toBe(false);
  });
});

describe("canMoveAnywhere", () => {
  it("is false for a task a member cannot move at all", () => {
    expect(canMoveAnywhere(task({ assigned_user_id: null }), member, COLUMNS)).toBe(false);
  });

  it("is true for a member's own task even though verified is closed to them", () => {
    expect(canMoveAnywhere(task({ assigned_user_id: "u2" }), member, COLUMNS)).toBe(true);
  });

  it("is false when the only legal destination is the column it already sits in", () => {
    const done = task({ assigned_user_id: "u2", status: "implemented" });
    // A member holding an implemented task may still drop it back to todo or
    // in_progress, so this stays true — the guard only closes when nothing moves.
    expect(canMoveAnywhere(done, member, ["implemented", "verified"])).toBe(false);
  });
});
