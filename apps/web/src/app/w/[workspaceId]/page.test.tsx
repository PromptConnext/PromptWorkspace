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

const state: Record<string, { data?: unknown; loading: boolean; error?: string | null }> = {};
vi.mock("@/lib/hooks", () => ({
  useCloudGet: (path: string) => state[path.endsWith("/members") ? "members" : "projects"],
}));

beforeEach(() => {
  state.members = { data: undefined, loading: true };
  state.projects = { data: [], loading: false };
});
afterEach(cleanup);

describe("workspace home", () => {
  it("shows a neutral label, not '0 members', while members load", async () => {
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
    state.projects = { data: undefined, loading: false, error: "Failed to load projects" };
    await renderPage();
    expect(await screen.findByText("Failed to load projects")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet. Create your first project to start planning.")).toBeNull();
  });
});
