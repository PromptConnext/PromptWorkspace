import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/types";
import { changeProgress } from "./changeProgress";

const task = (o: Partial<Task>): Task =>
  ({ id: "t", change_id: "c1", status: "todo", deleted_at: null, ...o }) as unknown as Task;

describe("changeProgress", () => {
  it("counts a Change's implemented and verified tasks over all of its tasks", () => {
    const tasks = [
      task({ id: "a", status: "implemented" }),
      task({ id: "b", status: "verified" }),
      task({ id: "c", status: "in_progress" }),
      task({ id: "d", status: "todo" }),
      task({ id: "e", change_id: "c2", status: "verified" }),
      task({ id: "f", change_id: null, status: "verified" }),
    ];
    expect(changeProgress("c1", tasks)).toEqual({ done: 2, total: 4 });
    expect(changeProgress("c2", tasks)).toEqual({ done: 1, total: 1 });
    expect(changeProgress("none", tasks)).toEqual({ done: 0, total: 0 });
  });

  it("ignores a retired (tombstoned) task, as the server's own count does", () => {
    const tasks = [
      task({ id: "a", status: "implemented" }),
      task({ id: "b", status: "verified", deleted_at: "2026-10-09T00:00:00Z" }),
      task({ id: "c", status: "todo", deleted_at: "2026-10-09T00:00:00Z" }),
    ];
    expect(changeProgress("c1", tasks)).toEqual({ done: 1, total: 1 });
  });
});
