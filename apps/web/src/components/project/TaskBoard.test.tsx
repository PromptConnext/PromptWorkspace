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

// A URL that answers back: the board reads its filters and open task from the
// query string, so a write has to re-render the board the way Next would.
const nav = vi.hoisted(() => ({ query: "", listeners: new Set<() => void>() }));
const router = vi.hoisted(() => ({
  replace: (url: string) => {
    nav.query = url.split("?")[1] ?? "";
    nav.listeners.forEach((notify) => notify());
  },
}));

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (notify: () => void) => {
    nav.listeners.add(notify);
    return () => nav.listeners.delete(notify);
  };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => nav.query)),
    usePathname: () => "/w/ws1/p/p1",
    useRouter: () => router,
  };
});

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

function board(tasks: Task[], extra: Partial<ProjectGraph> = {}) {
  return render(
    <ToastProvider>
      <TaskBoard graph={{ ...graphWith(tasks), ...extra }} workspaceId="ws1" projectId="p1" />
    </ToastProvider>,
  );
}

/** Card titles in the column, top to bottom — the thing the reorder bug moved. */
function columnOrder(label: string): string[] {
  const column = screen.getByRole("region", { name: new RegExp(`^${label}, \\d+ tasks?$`) });
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
  nav.query = "tab=tasks";
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

    const first = screen.getAllByRole("combobox", { name: /^Assignee for/ })[0];
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
    await pick(screen.getAllByRole("combobox", { name: /^Assignee for/ })[0], "dev@example.com");

    await waitFor(() => expect(assignTask).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rolls back and explains the failure in a toast", async () => {
    assignTask.mockRejectedValue(new Error("assignment_forbidden"));
    board([task({ id: "t1", feature_tag: "T001" })]);
    await screen.findByText("Task t1");

    const control = screen.getByRole("combobox", { name: /^Assignee for/ });
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

    await pick(screen.getByRole("combobox", { name: /^Assignee for/ }), "dev@example.com");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(assignTask).toHaveBeenCalledTimes(2));
    expect(assignTask.mock.calls[1][2]).toBe("u2");
  });

  it("offers a member a one-click claim instead of a picker holding only themselves", async () => {
    auth.userId = "u2";
    assignTask.mockResolvedValue({ ...THREE[0], assigned_user_id: "u2" });
    board([task({ id: "t1", feature_tag: "T001" })]);
    await screen.findByText("Task t1");

    expect(screen.queryByRole("combobox", { name: /^Assignee for/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Assign to Me/ }));

    await waitFor(() => expect(assignTask).toHaveBeenCalledWith("p1", "t1", "u2", expect.anything()));
    expect(await screen.findByRole("button", { name: "Unassign me from T001" })).toBeInTheDocument();
  });

  it("lets a member release a task they hold", async () => {
    auth.userId = "u2";
    const held = task({ id: "t1", feature_tag: "T001", assigned_user_id: "u2" });
    assignTask.mockResolvedValue({ ...held, assigned_user_id: null });
    board([held]);
    await screen.findByText("Task t1");

    expect(screen.getByTitle("dev@example.com")).toHaveTextContent("dev");
    await userEvent.click(screen.getByRole("button", { name: "Unassign me from T001" }));

    await waitFor(() => expect(assignTask).toHaveBeenCalledWith("p1", "t1", null, expect.anything()));
    expect(await screen.findByRole("button", { name: /^Assign to Me/ })).toBeInTheDocument();
  });

  it("confirms an assignment with an Undo that restores the previous owner", async () => {
    assignTask.mockResolvedValueOnce({ ...THREE[0], assigned_user_id: "u2" });
    assignTask.mockResolvedValueOnce({ ...THREE[0], assigned_user_id: null });
    board([task({ id: "t1", feature_tag: "T001" })]);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: /^Assignee for/ }), "dev@example.com");
    await waitFor(() => expect(notifications()).toHaveTextContent("Assigned T001 to dev"));

    await userEvent.click(within(notifications()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(assignTask).toHaveBeenCalledTimes(2));
    expect(assignTask.mock.calls[1][2]).toBeNull();
  });

  it("names a member, never their id, and hides a tracker assignee that matches", async () => {
    board([
      task({ id: "t1", feature_tag: "T001", assigned_user_id: "u2", assignee: "dev" }),
      task({ id: "t2", feature_tag: "T002", assigned_user_id: "u2", assignee: "someone-else" }),
      task({ id: "t3", feature_tag: "T003", assigned_user_id: "gone-user-id" }),
    ]);
    await screen.findByText("Task t1");

    expect(screen.queryByText("Tracker: dev")).not.toBeInTheDocument();
    expect(screen.getByText("Tracker: someone-else")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown member").length).toBeGreaterThan(0);
    expect(screen.queryByText(/gone-user-id/)).not.toBeInTheDocument();
  });
});

describe("TaskBoard members", () => {
  const UUID = "8d1f3c2a-4b5e-4f60-9a7b-1c2d3e4f5a6b";

  it("shows a skeleton, not locked cards, while members load", async () => {
    listMembers.mockReturnValue(new Promise(() => {}));
    const { container } = board([task({ id: "t1", feature_tag: "T001" })]);

    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByText("Task t1")).not.toBeInTheDocument();
  });

  it("explains a failed member load, offers Retry, and never prints a user id", async () => {
    listMembers.mockRejectedValueOnce(new Error("network"));
    board([task({ id: "t1", feature_tag: "T001", assigned_user_id: UUID })]);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load workspace members");
    expect(screen.getByText("Task t1")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(UUID))).not.toBeInTheDocument();
    expect(screen.getByText("Unknown member")).toBeInTheDocument();
    // Read-only: no picker, no move menu, no drag handle. (The toolbar's
    // filters only read, so they stay.)
    expect(
      screen.queryByRole("combobox", { name: /^Assignee for|to another column$/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move task/ })).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(listMembers).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("combobox", { name: /^Assignee for/ })).toBeInTheDocument();
  });
});

describe("TaskBoard layout", () => {
  it("shows one empty state with a way to the Planner when there are no tasks", async () => {
    const onOpenPlanner = vi.fn();
    render(
      <ToastProvider>
        <TaskBoard
          graph={graphWith([])}
          workspaceId="ws1"
          projectId="p1"
          onOpenPlanner={onOpenPlanner}
        />
      </ToastProvider>,
    );

    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^To Do/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to Planner" }));
    expect(onOpenPlanner).toHaveBeenCalledTimes(1);
  });

  it("labels each column with its task count", async () => {
    board(THREE);
    await screen.findByText("Task t1");
    expect(screen.getByRole("region", { name: "To Do, 3 tasks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Verified, 0 tasks" })).toBeInTheDocument();
  });

  it("gives a movable card a named keyboard drag handle", async () => {
    board([task({ id: "t1", feature_tag: "T001", title: "Login form" })]);
    const handle = await screen.findByRole("button", { name: "Move task T001 · Login form" });
    expect(handle).toHaveAttribute("aria-roledescription", "draggable task");
  });

  it("links a task's commit by its short sha", async () => {
    board([task({ id: "t1", feature_tag: "T001" })], {
      artifacts: [
        {
          id: "a1",
          project_id: "p1",
          task_id: "t1",
          kind: "code",
          uri: "https://github.com/acme/app/commit/abcdef1234567",
          commit_sha: "abcdef1234567",
          updated_at: null,
          deleted_at: null,
          field_versions: {},
        },
      ],
    });
    const link = await screen.findByRole("link", { name: "Commit abcdef1" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/app/commit/abcdef1234567");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});

describe("TaskBoard status", () => {
  it("moves a card to the target column optimistically", async () => {
    setTaskStatus.mockResolvedValue({ ...THREE[0], status: "in_progress" });
    board(THREE);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Move T001 to another column" }), "In Progress");

    await waitFor(() => expect(columnOrder("In Progress")).toEqual(["Task t1"]));
    expect(columnOrder("To Do")).toEqual(["Task t2", "Task t3"]);
    expect(setTaskStatus).toHaveBeenCalledWith("p1", "t1", "in_progress", expect.anything());
  });

  it("returns the card to its column when the move is rejected", async () => {
    setTaskStatus.mockRejectedValue(new Error("status_forbidden"));
    board(THREE);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Move T001 to another column" }), "In Progress");

    await waitFor(() => expect(notifications()).toHaveTextContent("Couldn't move T001"));
    expect(columnOrder("To Do")).toEqual(["Task t1", "Task t2", "Task t3"]);
    expect(columnOrder("In Progress")).toEqual([]);
  });

  it("locks status on a task a member does not hold", async () => {
    auth.userId = "u2";
    board([task({ id: "t1", feature_tag: "T001", assigned_user_id: "u9" })]);
    await screen.findByText("Task t1");

    expect(screen.queryByRole("combobox", { name: /to another column/ })).not.toBeInTheDocument();
    // The lock keeps a hover title, and carries the reason as text for touch
    // and screen-reader users, who never see a title.
    expect(screen.getAllByTitle(/Only the assignee or a workspace admin/).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Only the assignee or a workspace admin can move this task"),
    ).toBeInTheDocument();
  });

  it("confirms a move with an Undo that puts the card back", async () => {
    setTaskStatus.mockResolvedValueOnce({ ...THREE[0], status: "in_progress" });
    setTaskStatus.mockResolvedValueOnce({ ...THREE[0], status: "todo" });
    board(THREE);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Move T001 to another column" }), "In Progress");
    await waitFor(() => expect(notifications()).toHaveTextContent("Moved T001 to In Progress"));

    await userEvent.click(within(notifications()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledTimes(2));
    expect(setTaskStatus.mock.calls[1]).toEqual(["p1", "t1", "todo", expect.anything()]);
    await waitFor(() => expect(columnOrder("To Do")).toEqual(["Task t1", "Task t2", "Task t3"]));
  });

  it("explains an unrecognised failure in plain words, code secondary", async () => {
    setTaskStatus.mockRejectedValue(new Error("db_timeout"));
    board(THREE);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Move T001 to another column" }), "In Progress");
    await waitFor(() =>
      expect(notifications()).toHaveTextContent("Something went wrong saving this change."),
    );
    expect(notifications()).toHaveTextContent("(code: db_timeout)");
  });

  it("refuses `verified` to a member holding the task, as the endpoint does", async () => {
    auth.userId = "u2";
    board([task({ id: "t1", feature_tag: "T001", assigned_user_id: "u2" })]);
    await screen.findByText("Task t1");

    await userEvent.click(screen.getByRole("combobox", { name: "Move T001 to another column" }));
    const verified = await screen.findByRole("option", { name: "Verified" });
    expect(verified).toHaveAttribute("aria-disabled", "true");
  });

  it("lets an admin mark a task verified", async () => {
    const held = task({ id: "t1", feature_tag: "T001", assigned_user_id: "u2" });
    setTaskStatus.mockResolvedValue({ ...held, status: "verified" as TaskStatus });
    board([held]);
    await screen.findByText("Task t1");

    await pick(screen.getByRole("combobox", { name: "Move T001 to another column" }), "Verified");
    await waitFor(() => expect(columnOrder("Verified")).toEqual(["Task t1"]));
  });
});

describe("TaskBoard filters, lanes and drawer", () => {
  const MIXED = [
    task({ id: "t1", feature_tag: "T001", title: "Login form", assigned_user_id: "u1" }),
    task({ id: "t2", feature_tag: "T002", title: "Signup page", assigned_user_id: "u2" }),
    task({ id: "t3", feature_tag: "T003", title: "Password reset" }),
  ];

  function cardTitles(): string[] {
    return screen
      .queryAllByRole("button", { name: /^(Login form|Signup page|Password reset)$/ })
      .map((el) => el.textContent ?? "");
  }

  it("narrows the cards to a search", async () => {
    board(MIXED);
    await screen.findByText("Login form");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search tasks" }), "sign");

    await waitFor(() => expect(cardTitles()).toEqual(["Signup page"]));
    expect(new URLSearchParams(nav.query).get("q")).toBe("sign");
    expect(screen.getByText("Showing 1 of 3 tasks")).toBeInTheDocument();
  });

  it("shows only the viewer's tasks under My Tasks, and from the m shortcut", async () => {
    board(MIXED);
    await screen.findByText("Login form");

    await userEvent.click(screen.getByRole("button", { name: "My Tasks" }));
    await waitFor(() => expect(cardTitles()).toEqual(["Login form"]));
    expect(new URLSearchParams(nav.query).get("assignee")).toBe("me");

    await userEvent.keyboard("m");
    await waitFor(() => expect(cardTitles()).toHaveLength(3));
  });

  it("focuses search on /", async () => {
    board(MIXED);
    await screen.findByText("Login form");

    await userEvent.keyboard("/");
    expect(screen.getByRole("searchbox", { name: "Search tasks" })).toHaveFocus();
  });

  it("says when filters hide every task, and clears them", async () => {
    nav.query = "tab=tasks&q=nothing-matches&group=assignee";
    board(MIXED);

    expect(await screen.findByText("No tasks match these filters")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^To Do/ })).not.toBeInTheDocument();

    const empty = screen.getByText("No tasks match these filters").parentElement as HTMLElement;
    await userEvent.click(within(empty).getByRole("button", { name: "Clear Filters" }));

    await waitFor(() => expect(cardTitles()).toHaveLength(3));
    // Grouping is a layout, not a filter; it survives Clear.
    expect(nav.query).toBe("tab=tasks&group=assignee");
  });

  it("opens a task's details from its title and closes them again", async () => {
    board(MIXED);
    await userEvent.click(await screen.findByRole("button", { name: "Signup page" }));

    const dialog = await screen.findByRole("dialog", { name: "Signup page" });
    expect(new URLSearchParams(nav.query).get("task")).toBe("t2");
    // The card's assignee picker, reused in the drawer.
    expect(within(dialog).getByRole("combobox", { name: "Assignee for T002" })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Close task details" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(new URLSearchParams(nav.query).get("task")).toBeNull();
  });

  it("moves a task from the drawer through the board's write path", async () => {
    setTaskStatus.mockResolvedValue({ ...MIXED[0], status: "in_progress" });
    nav.query = "tab=tasks&task=t1";
    board(MIXED);

    const dialog = await screen.findByRole("dialog", { name: "Login form" });
    await pick(
      within(dialog).getByRole("combobox", { name: "Move T001 to another column" }),
      "In Progress",
    );

    await waitFor(() =>
      expect(within(dialog).getByText("In Progress", { selector: "dd span" })).toBeInTheDocument(),
    );
    expect(setTaskStatus).toHaveBeenCalledWith("p1", "t1", "in_progress", expect.anything());
    await waitFor(() => expect(notifications()).toHaveTextContent("Moved T001 to In Progress"));
  });

  it("drops a link to a task that isn't on the board", async () => {
    nav.query = "tab=tasks&task=gone";
    board(MIXED);
    await screen.findByText("Login form");

    await waitFor(() => expect(nav.query).toBe("tab=tasks"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("groups into collapsible swimlanes by assignee", async () => {
    nav.query = "tab=tasks&group=assignee";
    board(MIXED);
    await screen.findByText("Login form");

    // A lane is the region its expand toggle heads; the columns inside are
    // regions too.
    const lanes = screen
      .getAllByRole("button", { expanded: true })
      .map((toggle) => toggle.closest("section") as HTMLElement);
    expect(lanes.map((l) => l.getAttribute("aria-label"))).toEqual([
      "admin, 1 task",
      "dev, 1 task",
      "Unassigned, 1 task",
    ]);
    expect(within(lanes[1]).getByText("Signup page")).toBeInTheDocument();
    expect(within(lanes[1]).getByRole("region", { name: "To Do, 1 task" })).toBeInTheDocument();

    const toggle = within(lanes[1]).getByRole("button", { name: /^dev/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(lanes[1]).queryByText("Signup page")).not.toBeInTheDocument();
  });

  it("moves a card's status inside its lane", async () => {
    setTaskStatus.mockResolvedValue({ ...MIXED[1], status: "in_progress" });
    nav.query = "tab=tasks&group=assignee";
    board(MIXED);
    await screen.findByText("Signup page");

    await pick(
      screen.getByRole("combobox", { name: "Move T002 to another column" }),
      "In Progress",
    );

    const lane = screen.getByRole("region", { name: "dev, 1 task" });
    await waitFor(() =>
      expect(
        within(within(lane).getByRole("region", { name: "In Progress, 1 task" })).getByText(
          "Signup page",
        ),
      ).toBeInTheDocument(),
    );
  });
});
