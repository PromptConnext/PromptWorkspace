import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardToolbar } from "./BoardToolbar";
import { EMPTY_FILTERS } from "@/lib/boardFilters";
import type { BoardFilters } from "@/lib/boardFilters";
import type { WorkspaceMember } from "@/lib/types";

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

function setup(filters: Partial<BoardFilters> = {}, counts = { result: 23, total: 23 }) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  const props = {
    filters: { ...EMPTY_FILTERS, ...filters },
    onChange,
    onClear,
    members,
    sprints: ["Sprint 1"],
    specs: [{ id: "s1", label: "Login flow" }],
    viewerId: "u1",
    resultCount: counts.result,
    totalCount: counts.total,
  };
  const view = render(<BoardToolbar {...props} />);
  return { onChange, onClear, props, view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BoardToolbar", () => {
  it("toggles My Tasks through aria-pressed and onChange", async () => {
    const user = userEvent.setup();
    const { onChange, props, view } = setup();
    const button = screen.getByRole("button", { name: "My Tasks" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);
    expect(onChange).toHaveBeenLastCalledWith({ assignee: "me" });

    view.rerender(<BoardToolbar {...props} filters={{ ...props.filters, assignee: "me" }} />);
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.click(button);
    expect(onChange).toHaveBeenLastCalledWith({ assignee: null });
  });

  it("shows Clear Filters only when a filter is active", async () => {
    const user = userEvent.setup();
    const { onClear, props, view } = setup({ group: "assignee" });
    expect(screen.queryByRole("button", { name: "Clear Filters" })).toBeNull();

    view.rerender(<BoardToolbar {...props} filters={{ ...props.filters, sprint: "Sprint 1" }} />);
    await user.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("announces the filtered count in a polite live region", () => {
    setup({ q: "login" }, { result: 5, total: 23 });
    const status = screen.getByText("Showing 5 of 23 tasks");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("debounces typed search and clears it on Escape", () => {
    vi.useFakeTimers();
    const { onChange } = setup();
    const input = screen.getByRole("searchbox", { name: "Search tasks" });

    fireEvent.change(input, { target: { value: "log" } });
    expect(input).toHaveValue("log");
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: "log" });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith({ q: "" });
  });

  it("resets the input when q is cleared from outside", () => {
    const { props, view } = setup({ q: "login" });
    const input = screen.getByRole("searchbox", { name: "Search tasks" });
    expect(input).toHaveValue("login");
    view.rerender(<BoardToolbar {...props} filters={EMPTY_FILTERS} />);
    expect(input).toHaveValue("");
  });

  it("hides the sprint and spec pickers when there is nothing to pick", () => {
    render(
      <BoardToolbar
        filters={EMPTY_FILTERS}
        onChange={vi.fn()}
        onClear={vi.fn()}
        members={members}
        sprints={[]}
        specs={[]}
        viewerId="u1"
        resultCount={0}
        totalCount={0}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Sprint" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Spec" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Group By" })).toBeInTheDocument();
  });
});
