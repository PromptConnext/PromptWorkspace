import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOptimisticTasks } from "./useOptimisticTasks";
import type { Task } from "@/lib/types";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    project_id: "p1",
    spec_id: null,
    title: "A task",
    status: "todo",
    feature_tag: "T001",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useOptimisticTasks", () => {
  it("shows the new value before the write resolves", async () => {
    const rows = [task({ id: "t1" })];
    const gate = deferred<Task>();
    const { result } = renderHook(() => useOptimisticTasks(rows));

    let done!: Promise<void>;
    act(() => {
      done = result.current.mutate(rows[0], {
        patch: { assigned_user_id: "u2" },
        request: () => gate.promise,
      });
    });

    expect(result.current.tasks[0].assigned_user_id).toBe("u2");
    expect(result.current.savingIds.has("t1")).toBe(true);

    await act(async () => {
      gate.resolve(task({ id: "t1", assigned_user_id: "u2", updated_at: "2026-08-09T00:00:00Z" }));
      await done;
    });

    expect(result.current.tasks[0].assigned_user_id).toBe("u2");
    expect(result.current.savingIds.has("t1")).toBe(false);
  });

  it("rolls the value back and reports the error when the write fails", async () => {
    const rows = [task({ id: "t1", assigned_user_id: "u1" })];
    const { result } = renderHook(() => useOptimisticTasks(rows));
    const seen: Error[] = [];

    await act(async () => {
      await result.current.mutate(rows[0], {
        patch: { assigned_user_id: "u2" },
        request: () => Promise.reject(new Error("assignment_forbidden")),
        onError: (err) => seen.push(err),
      });
    });

    expect(result.current.tasks[0].assigned_user_id).toBe("u1");
    expect(result.current.savingIds.size).toBe(0);
    expect(seen.map((e) => e.message)).toEqual(["assignment_forbidden"]);
  });

  it("keeps a saved override until the server row catches up", async () => {
    const rows = [task({ id: "t1", status: "todo" })];
    const { result, rerender } = renderHook(({ tasks }) => useOptimisticTasks(tasks), {
      initialProps: { tasks: rows },
    });

    await act(async () => {
      await result.current.mutate(rows[0], {
        patch: { status: "in_progress" },
        request: async () =>
          task({ id: "t1", status: "in_progress", updated_at: "2026-08-09T00:00:00Z" }),
      });
    });

    // A refetch triggered by some other part of the page still carries the old
    // row; the override must not be thrown away by it.
    rerender({ tasks: [task({ id: "t1", status: "todo", updated_at: "2026-08-01T00:00:00Z" })] });
    expect(result.current.tasks[0].status).toBe("in_progress");

    // Once the server's copy is at least as new it is authoritative again,
    // including when it carries somebody else's later edit.
    rerender({ tasks: [task({ id: "t1", status: "verified", updated_at: "2026-08-10T00:00:00Z" })] });
    expect(result.current.tasks[0].status).toBe("verified");
  });

  it("returns tasks in stable reference order regardless of input order", () => {
    const rows = [task({ id: "b", feature_tag: "T002" }), task({ id: "a", feature_tag: "T001" })];
    const { result } = renderHook(() => useOptimisticTasks(rows));
    expect(result.current.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
