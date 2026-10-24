import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspacePage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({}) }),
}));
vi.mock("@/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/NewProjectDialog", () => ({
  NewProjectDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (project: { id: string }) => void;
  }) =>
    open ? (
      <div role="dialog">
        New project dialog
        <button type="button" onClick={() => onCreated({ id: "p9" })}>
          created
        </button>
      </div>
    ) : null,
}));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    memberships: [{ id: "w1" }],
    loading: false,
    error: null,
    setActiveWorkspace: vi.fn(),
  }),
  useWorkspaceName: () => "Acme",
  useIsWorkspaceAdmin: () => false,
}));

// React's `use` reads status/value off a settled thenable synchronously, so
// the page renders without suspending.
const params = Object.assign(Promise.resolve({ workspaceId: "w1" }), {
  status: "fulfilled",
  value: { workspaceId: "w1" },
});
async function renderPage() {
  const view = render(
    <Suspense fallback={null}>
      <WorkspacePage params={params} />
    </Suspense>,
  );
  await act(async () => {
    await params;
  });
  return view;
}

type Slot = { data?: unknown; loading: boolean; error?: string | null };
const state: { overview: Slot; decisions: Slot } = {
  overview: { loading: true },
  decisions: { loading: true },
};
vi.mock("@/lib/hooks", () => ({
  useCloudGet: (path: string) => ({
    refetch: vi.fn(),
    ...(path.includes("/me/decisions") ? state.decisions : state.overview),
  }),
}));

function overview(over: Record<string, unknown> = {}) {
  return {
    workspace_id: "w1",
    generated_at: "2026-10-24T00:00:00Z",
    truncated: false,
    members: [],
    projects: [],
    people: [],
    ...over,
  };
}

beforeEach(() => {
  state.overview = { data: overview(), loading: false };
  state.decisions = { data: undefined, loading: true };
});
afterEach(cleanup);

describe("workspace home", () => {
  it("shows a neutral label, not '0 members', while members load", async () => {
    state.overview = { data: undefined, loading: true };
    await renderPage();
    expect(await screen.findByText("Members", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/0 members/)).toBeNull();
  });

  it("empty state offers a New Project button that opens the dialog", async () => {
    await renderPage();
    expect(
      await screen.findByText("No projects yet. Create your first project to start planning."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the dialog open while the new project opens", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New Project" }));
    fireEvent.click(screen.getByRole("button", { name: "created" }));

    expect(push).toHaveBeenCalledWith("/w/w1/p/p9");
    // Not closed onto the "No projects yet" list for the seconds the
    // navigation takes (finding #4).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("hides empty state when fetch error occurs", async () => {
    state.overview = { data: undefined, loading: false, error: "Failed to load projects" };
    await renderPage();
    expect(await screen.findByText("Failed to load projects")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet. Create your first project to start planning.")).toBeNull();
  });

  it("shows the number of decisions waiting on the Inbox button", async () => {
    state.decisions = { data: [{ id: "a" }, { id: "b" }], loading: false };
    await renderPage();
    expect(await screen.findByRole("link", { name: "Inbox · 2" })).toHaveAttribute(
      "href",
      "/w/w1/inbox",
    );
  });

  it("notes when the project list is truncated", async () => {
    state.overview = { data: overview({ truncated: true }), loading: false };
    await renderPage();
    expect(
      await screen.findByText("Showing the 200 most recently updated projects."),
    ).toBeInTheDocument();
  });

  it("has no truncation note otherwise", async () => {
    await renderPage();
    await screen.findByText("Projects");
    expect(screen.queryByText(/most recently updated/)).toBeNull();
  });

  it("shows plain Inbox when nothing is waiting", async () => {
    state.decisions = { data: [], loading: false };
    await renderPage();
    expect(await screen.findByRole("link", { name: "Inbox" })).toBeInTheDocument();
  });
});
