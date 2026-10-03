import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDrawer } from "./TaskDrawer";
import type { ProjectGraph, Task, WorkspaceMember } from "@/lib/types";

const members: WorkspaceMember[] = [
  {
    workspace_id: "ws1",
    user_id: "u1",
    email: "dev-user@promptworkspace.local",
    role: "member",
    invited_by: null,
    created_at: "2026-08-01T00:00:00Z",
  },
];

const task: Task = {
  id: "t1",
  project_id: "p1",
  spec_id: "s1",
  title: "Build the login form",
  status: "in_progress",
  feature_tag: "T004 [P]",
  acceptance_criteria: [{ text: "Rejects a wrong password" }, { text: "Shows a spinner" }],
  assignee: "jira-bob",
  sprint: "Sprint 3",
  assigned_user_id: "u1",
  updated_at: "2026-08-01T00:00:00Z",
  deleted_at: null,
  field_versions: {},
};

const graph: ProjectGraph = {
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
  requirements: [
    {
      id: "r1",
      project_id: "p1",
      title: "Sign-in",
      description: "",
      status: "approved",
      updated_at: null,
      deleted_at: null,
      field_versions: {},
    },
  ],
  spec_documents: [
    {
      id: "s1",
      project_id: "p1",
      requirement_id: "r1",
      content: "",
      version: 2,
      status: "approved",
      approved_by: null,
      updated_at: null,
      deleted_at: null,
      field_versions: {},
    },
  ],
  tasks: [task],
  artifacts: [
    {
      id: "a1",
      project_id: "p1",
      task_id: "t1",
      kind: "code",
      uri: "https://github.com/acme/widget/commit/abcdef1234567890",
      commit_sha: "abcdef1234567890",
      updated_at: null,
      deleted_at: null,
      field_versions: {},
    },
    {
      id: "a2",
      project_id: "p1",
      task_id: "other",
      kind: "doc",
      uri: "https://example.com/elsewhere",
      commit_sha: null,
      updated_at: null,
      deleted_at: null,
      field_versions: {},
    },
  ],
  agent_runs: [
    {
      id: "run1",
      project_id: "p1",
      task_id: "t1",
      model_role: "coder",
      action: "implement",
      status: "succeeded",
      evidence: {},
      updated_at: "2026-08-01T00:00:00Z",
      deleted_at: null,
      field_versions: {},
    },
  ],
  discussions: [],
  cursor: null,
  next_id: null,
  has_more: false,
};

afterEach(() => {
  cleanup();
});

describe("TaskDrawer", () => {
  it("renders nothing without a task", () => {
    const { container } = render(
      <TaskDrawer task={null} graph={graph} members={members} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the task's details", () => {
    render(<TaskDrawer task={task} graph={graph} members={members} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Build the login form" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("T004")).toHaveAttribute("translate", "no");
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("dev-user@promptworkspace.local")).toBeInTheDocument();
    expect(screen.getByText("Sprint 3")).toBeInTheDocument();
    expect(screen.getByText("@jira-bob")).toBeInTheDocument();
    expect(screen.getByText("Acceptance Criteria (2)")).toBeInTheDocument();
    expect(screen.getByText("Rejects a wrong password")).toBeInTheDocument();
    expect(screen.getByText("Sign-in")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.queryByText("https://example.com/elsewhere")).toBeNull();
  });

  it("uses the slots when provided", () => {
    render(
      <TaskDrawer
        task={task}
        graph={graph}
        members={members}
        onClose={vi.fn()}
        renderAssignee={(t) => <span>assignee slot {t.id}</span>}
        renderMove={(t) => <span>move slot {t.id}</span>}
      />,
    );
    expect(screen.getByText("assignee slot t1")).toBeInTheDocument();
    expect(screen.getByText("move slot t1")).toBeInTheDocument();
  });

  it("shows the empty acceptance-criteria state", () => {
    render(
      <TaskDrawer
        task={{ ...task, acceptance_criteria: [] }}
        graph={graph}
        members={members}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("No acceptance criteria")).toBeInTheDocument();
  });

  it("links commit artifacts by short sha in a new tab", () => {
    render(<TaskDrawer task={task} graph={graph} members={members} onClose={vi.fn()} />);
    const link = screen.getByRole("link", { name: "abcdef1" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widget/commit/abcdef1234567890");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("closes on Escape and on the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TaskDrawer task={task} graph={graph} members={members} onClose={onClose} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close task details" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores an Escape something else already handled", () => {
    const onClose = vi.fn();
    render(<TaskDrawer task={task} graph={graph} members={members} onClose={onClose} />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus in, traps Tab, locks scroll, and restores focus on close", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <TaskDrawer
            task={open ? task : null}
            graph={graph}
            members={members}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);

    const close = screen.getByRole("button", { name: "Close task details" });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    // Shift+Tab from the first control wraps to the last one inside the dialog.
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Copy Link" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("copies the page link and confirms inline", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<TaskDrawer task={task} graph={graph} members={members} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Copy Link" }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText("Copied")).toHaveAttribute("aria-live", "polite");
  });
});
