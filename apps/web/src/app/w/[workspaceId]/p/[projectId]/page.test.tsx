import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectPage from "./page";

const replace = vi.fn();
let search = "";
let refreshError: string | null = null;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/w/w1/p/p1",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, use: () => ({ workspaceId: "w1", projectId: "p1" }) };
});
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/PresenceBar", () => ({ PresenceBar: () => null }));
vi.mock("@/lib/workspace", () => ({ useWorkspaceName: () => "WS" }));
vi.mock("@/components/project/GraphBrowser", () => ({
  GraphBrowser: () => <div>graph-view</div>,
}));
vi.mock("@/components/project/Planner", () => ({
  Planner: () => <div>planner-view</div>,
}));
vi.mock("@/components/project/PreviewPanel", () => ({
  PreviewPanel: () => null,
}));
vi.mock("@/components/project/TaskBoard", () => ({
  TaskBoard: () => <div>board-view</div>,
}));
vi.mock("@/components/project/ProgressRollup", () => ({
  ProgressRollup: () => null,
}));
vi.mock("@/components/project/DiscussionThread", () => ({
  DiscussionThread: () => null,
}));
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({
    data: { project: { name: "P" } },
    error: null,
    loading: false,
    refetch: vi.fn(),
    refreshing: false,
    refreshError,
    lastUpdated: Date.now(),
    revalidate: vi.fn(),
  }),
}));

beforeEach(() => {
  replace.mockReset();
  search = "";
  refreshError = null;
});
afterEach(cleanup);

describe("project page tab URL sync", () => {
  it("defaults to Planner and treats unknown slugs as Planner", () => {
    search = "tab=bogus";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.getByRole("tab", { name: "Planner" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("planner-view")).toBeInTheDocument();
  });

  it("reads the tab from the URL and widens main on Tasks", () => {
    search = "tab=tasks";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.getByText("board-view")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("max-w-none");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("clicking a tab replaces the URL and preserves other params", () => {
    search = "foo=bar";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(replace).toHaveBeenCalledWith("/w/w1/p/p1?foo=bar&tab=graph", {
      scroll: false,
    });
  });

  it("arrow keys and End move between tabs", () => {
    search = "tab=planner";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Planner" }), {
      key: "ArrowRight",
    });
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=graph", {
      scroll: false,
    });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Planner" }), {
      key: "ArrowLeft",
    });
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=preview", {
      scroll: false,
    });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Planner" }), {
      key: "End",
    });
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=preview", {
      scroll: false,
    });
  });

  it("drops the open task when leaving Tasks, and keeps it on Tasks", () => {
    search = "tab=tasks&task=t1";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=graph", {
      scroll: false,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=tasks&task=t1", {
      scroll: false,
    });
  });
});

describe("board freshness", () => {
  function renderTasks() {
    search = "tab=tasks";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
  }

  it("does not put the ticking 'Updated' label in a live region", () => {
    renderTasks();
    const label = screen.getByText(/^Updated /);
    expect(label.closest("[aria-live]")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces a failed refresh through a status region", () => {
    refreshError = "boom";
    renderTasks();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't refresh — showing last loaded data.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
