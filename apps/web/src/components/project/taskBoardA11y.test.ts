import { describe, expect, it } from "vitest";
import type { Active, Over } from "@dnd-kit/core";
import type { Task } from "@/lib/types";
import { buildAnnouncements, columnOf, explain, laneDropId } from "./taskBoardA11y";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    project_id: "p1",
    spec_id: null,
    title: "Login form",
    status: "todo",
    feature_tag: "T004",
    acceptance_criteria: [],
    assignee: null,
    sprint: null,
    assigned_user_id: "u2",
    updated_at: "2026-08-01T00:00:00Z",
    deleted_at: null,
    field_versions: {},
    ...overrides,
  };
}

// The announcers only read `id` off active/over; the rest of dnd-kit's shape
// is irrelevant to the sentence.
const active = { id: "t4" } as unknown as Active;
const over = (id: string) => ({ id }) as unknown as Over;

const tasks = [task({ id: "t4" })];
const find = (id: string) => tasks.find((t) => t.id === id);
const member = buildAnnouncements(find, { userId: "u2", role: "member" });

describe("buildAnnouncements", () => {
  it("names the task by reference and title, and the column by label", () => {
    expect(member.onDragStart({ active })).toBe("Picked up T004 · Login form from To Do.");
    expect(member.onDragOver({ active, over: over("in_progress") })).toBe(
      "T004 · Login form is over In Progress.",
    );
    expect(member.onDragEnd({ active, over: over("in_progress") })).toBe(
      "Moved T004 · Login form from To Do to In Progress.",
    );
  });

  it("never reads out an id", () => {
    const said = [
      member.onDragStart({ active }),
      member.onDragOver({ active, over: over("implemented") }),
      member.onDragEnd({ active, over: null }),
      member.onDragCancel({ active, over: null }),
    ].join(" ");
    expect(said).not.toMatch(/t4\b|in_progress|implemented\b/);
  });

  it("says why an illegal drop was refused", () => {
    expect(member.onDragOver({ active, over: over("verified") })).toContain(
      "Only a workspace admin can mark a task verified.",
    );
    expect(member.onDragEnd({ active, over: over("verified") })).toBe(
      "Can't move T004 · Login form to Verified. Only a workspace admin can mark a task verified. It stays in To Do.",
    );
  });
});

describe("explain", () => {
  it("maps a known code to its sentence", () => {
    expect(explain(new Error("status_forbidden"))).toBe("You can only move tasks assigned to you.");
  });

  it("falls back to a generic sentence with a short code", () => {
    const text = explain(new Error("x".repeat(200)));
    expect(text).toMatch(/^Something went wrong saving this change\./);
    expect(text).toContain(`(code: ${"x".repeat(60)}…)`);
  });
});

describe("lane drop ids", () => {
  it("round-trips a status through a lane-scoped id", () => {
    expect(columnOf(laneDropId("u2", "in_progress"))).toBe("in_progress");
    expect(columnOf(laneDropId("__none__", "verified"))).toBe("verified");
  });

  it("reads the status after the last separator, whatever the lane key holds", () => {
    expect(columnOf(laneDropId("Sprint::2", "todo"))).toBe("todo");
  });

  it("still reads a bare status from an ungrouped board", () => {
    expect(columnOf("implemented")).toBe("implemented");
  });

  it("names no column for anything else", () => {
    expect(columnOf(undefined)).toBeNull();
    expect(columnOf("lane::done")).toBeNull();
    expect(columnOf("u2")).toBeNull();
  });
});
