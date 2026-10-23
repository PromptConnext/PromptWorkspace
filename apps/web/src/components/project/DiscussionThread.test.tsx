import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionThread } from "./DiscussionThread";
import type { ProjectGraph } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

function makeGraph(): ProjectGraph {
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
    tasks: [
      {
        id: "t1",
        project_id: "p1",
        spec_id: null,
        title: "Wire the OAuth callback",
        status: "todo",
        feature_tag: null,
        acceptance_criteria: [],
        assignee: null,
        sprint: null,
        assigned_user_id: null,
        change_id: null,
        updated_at: "2026-08-01T00:00:00Z",
        deleted_at: null,
        field_versions: {},
      },
    ],
    artifacts: [],
    agent_runs: [],
    discussions: [
      {
        id: "d1",
        project_id: "p1",
        parent_node_type: "tasks",
        parent_node_id: "t1",
        author: "Alice",
        body: "Looks good so far.",
        source: "pz",
        updated_at: "2026-08-01T00:00:00Z",
        deleted_at: null,
        field_versions: {},
      },
    ],
    cursor: null,
    next_id: null,
    has_more: false,
  };
}

describe("DiscussionThread", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not offer an existing comment as a reply target", () => {
    // The cloud rejects a comment parenting a comment with 422
    // invalid_parent_node_type (_VALID_PARENT_TYPES, app/api/discussions.py:30).
    // useNodeLabels covers discussions (the assistant's citation chips need
    // those labels), so the compose picker must filter them back out — this
    // locks that filtering in against a future edit to the shared hook.
    const graph = makeGraph();
    render(<DiscussionThread graph={graph} workspaceId="ws1" projectId="p1" onPosted={vi.fn()} />);

    // The picker is a Radix Select now, so its options only exist in the DOM
    // while it is open — and it opens on ArrowDown, which is the one path that
    // needs no pointer-capture emulation from happy-dom.
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const optionTexts = screen.getAllByRole("option").map((o) => o.textContent);

    expect(optionTexts).toContain("Task: Wire the OAuth callback");
    expect(optionTexts).not.toContain("Comment by Alice");
    expect(optionTexts.some((text) => text?.toLowerCase().includes("comment by"))).toBe(false);
  });
});
