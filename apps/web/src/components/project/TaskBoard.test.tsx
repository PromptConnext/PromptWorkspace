import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoard } from "./TaskBoard";
import { ToastProvider } from "@/lib/toast";
import type { ProjectGraph, Task, TaskStatus } from "@/lib/types";

const auth = { userId: "u1" };

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    authHeaders: () => ({ Authorization: "Bearer test" }),
    user: { id: auth.userId },
  }),
}));

const listMembers = vi.fn();
const assignTask = vi.fn();
const setTaskStatus = vi.fn();

vi.mock("@/lib/api", () => ({
  listMembers: (...args: unknown[]) => listMembers(...args),
  assignTask: (...args: unknown[]) => assignTask(...args),
  setTaskStatus: (...args: unknown[]) => setTaskStatus(...args),
}));

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

function graphWith(tasks: Task[]): ProjectGraph {
  return {
    project: {
      id: "p1",
      name: "Widget App",
      workspace_id: "ws1",
      owner_id: "u1",
      onboarding_state: "done",
      stage_state: {},
      lifecycle_status: "planning",
      repo_url: null,
      repo_default_branch: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
    requirements: [],
    spec_documents: [],
    tasks,
    artifacts: [],
    agent_runs: [],
    discussions: [],
    cursor: null,
    next_id: null,
    has_more: false,
  };
}

function board(tasks: Task[]) {
  return render(
    <ToastProvider>
      <TaskBoard graph={graphWith(tasks)} workspaceId="ws1" projectId="p1" />
    </ToastProvider>,
  );
}

/** Card titles in the column, top to bottom — the thing the reorder bug moved. */
function columnOrder(label: string): string[] {
  const column = screen.getByRole("region", { name: label });
  return within(column)
    .queryAllByText(/^Task /)
    .map((el) => el.textContent ?? "");
}

/** The toast stack, scoped so dnd-kit's own live region can't be mistaken for it. */
function notifications() {
  return screen.getByRole("region", { name: "Notifications" });
}

async function pick(trigger: HTMLElement, option: string | RegExp) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

const THREE = [
  task({ id: "t1", feature_tag: "T001" }),
  task({ id: "t2", feature_tag: "T002" }),
  task({ id: "t3", feature_tag: "T003" }),
];

beforeEach(() => {
  auth.userId = "u1";
  listMembers.mockResolvedValue([
    { user_id: "u1", email: "admin@example.com", role: "admin" },
    { user_id: "u2", email: "dev@example.com", role: "member" },
  ]);
  assignTask.mockReset();
  setTaskStatus.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskBoard assignment", () => {
  it("shows the new assignee immediately and leaves the card where it was", async () => {
    // The server bumps updated_at on assign; the board must not care.
    assignTask.mockResolvedValue({
      ...THREE[0],
      assigned_user_id: "u2",
      updated_at: "2026-08-09T00:00:00Z",
    });
    board(THREE);
    await screen.findByText("Task t1");
    expect(columnOrder("To Do")).toEqual(["Task t1", "Task t2", "Task t3"]);

    const first = screen.getAllByRole("combobox", { name: "Assignee" })[0];
    await pick(first, "dev@example.com");

    // The trigger shows the local part; the full address is the hover title.
    await waitFor(() => expect(first).toHaveTextContent("dev"));
    expect(first).toHaveAttribute("title", "dev@example.com");
    expect(columnOrder("To Do")).toEqual(["Task t1", "Task t2", "Task t3"]);
  });

  it("does not refetch the graph after a successful write", async () => {
    assignTask.mockResolvedValue({ ...THREE[0], assigned_user_id: "u2" });
    const onChange = vi.fn();
    render(
      <ToastProvider>
        <TaskBoard graph={graphWith(THREE)} workspaceId="ws1" projectId="p1" onChange={onChange} />
      </ToastProvider>,
    );
    await screen.findByText("Task t1");
    await pick(screen.getAllByRole("combobox", { name: "Assignee" })[0], "dev@example.com");

    await waitFor(() => expect(assignTask).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rolls back and explains the failure in a toast", async () => {
    assignTask.mockRejectedValue(new Error("assignment_forbidden"));
    board([task({ id: "t1", feature_tag: "T001" })]);
    await screen.findByText("Task t1");

    const control = screen.getByRole("combobox", { name: "Assignee" });
    await pick(control, "dev@example.com");

    await waitFor(() => expect(notifications()).toHaveTextContent("Couldn't assign T001"));
    expect(notifications()).toHaveTextContent("You can only assign tasks to yourself.");
    expect(control).toHaveTextContent("Unassigned");
  });

  it("retries the same write from the toast", async () => {
    assignTask.mockRejectedValueOnce(new Error("assignment_forbidden"));
    assignTask.mockResolvedValueOnce({ ...THREE[0], assigned_user_id: "u2" });
    board([task({ id: "t1", feature_tag: "T001" })]);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Assignee" }), "dev@example.com");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(assignTask).toHaveBeenCalledTimes(2));
    expect(assignTask.mock.calls[1][2]).toBe("u2");
  });

  it("offers a member only themselves, matching what the endpoint accepts", async () => {
    auth.userId = "u2";
    board([task({ id: "t1", feature_tag: "T001" })]);
    await screen.findByText("Task t1");

    await userEvent.click(screen.getByRole("combobox", { name: "Assignee" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Unassigned", "dev@example.com"]);
  });
});

describe("TaskBoard status", () => {
  it("moves a card to the target column optimistically", async () => {
    setTaskStatus.mockResolvedValue({ ...THREE[0], status: "in_progress" });
    board(THREE);
    await screen.findByText("Task t1");

    await pick(screen.getAllByRole("combobox", { name: "Status" })[0], "In Progress");

    await waitFor(() => expect(columnOrder("In Progress")).toEqual(["Task t1"]));
    expect(columnOrder("To Do")).toEqual(["Task t2", "Task t3"]);
    expect(setTaskStatus).toHaveBeenCalledWith("p1", "t1", "in_progress", expect.anything());
  });

  it("returns the card to its column when the move is rejected", async () => {
    setTaskStatus.mockRejectedValue(new Error("status_forbidden"));
    board(THREE);
    await screen.findByText("Task t1");

    await pick(screen.getAllByRole("combobox", { name: "Status" })[0], "In Progress");

    await waitFor(() => expect(notifications()).toHaveTextContent("Couldn't move T001"));
    expect(columnOrder("To Do")).toEqual(["Task t1", "Task t2", "Task t3"]);
    expect(columnOrder("In Progress")).toEqual([]);
  });

  it("locks status on a task a member does not hold", async () => {
    auth.userId = "u2";
    board([task({ id: "t1", feature_tag: "T001", assigned_user_id: "u9" })]);
    await screen.findByText("Task t1");

    expect(screen.queryByRole("combobox", { name: "Status" })).not.toBeInTheDocument();
    // Both the (undraggable) card and the read-only status chip explain why.
    expect(screen.getAllByTitle(/Only the assignee or a workspace admin/).length).toBeGreaterThan(0);
  });

  it("refuses `verified` to a member holding the task, as the endpoint does", async () => {
    auth.userId = "u2";
    board([task({ id: "t1", feature_tag: "T001", assigned_user_id: "u2" })]);
    await screen.findByText("Task t1");

    await userEvent.click(screen.getByRole("combobox", { name: "Status" }));
    const verified = await screen.findByRole("option", { name: "Verified" });
    expect(verified).toHaveAttribute("aria-disabled", "true");
  });

  it("lets an admin mark a task verified", async () => {
    const held = task({ id: "t1", feature_tag: "T001", assigned_user_id: "u2" });
    setTaskStatus.mockResolvedValue({ ...held, status: "verified" as TaskStatus });
    board([held]);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Status" }), "Verified");
    await waitFor(() => expect(columnOrder("Verified")).toEqual(["Task t1"]));
  });
});
