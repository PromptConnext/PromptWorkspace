import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InboxPage from "./page";

let items: unknown[] = [];
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, use: () => ({ workspaceId: "w1" }) };
});
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/lib/workspace", () => ({ useWorkspaceName: () => "WS" }));
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({ data: items, error: null, loading: false, refetch: vi.fn() }),
}));
afterEach(cleanup);

describe("Inbox", () => {
  it("links each waiting decision to its project's Decisions tab", () => {
    items = [
      {
        project_id: "p1", project_name: "Clinic booking", workspace_id: "w1", workspace_name: "WS",
        decision: { id: "d1", title: "Approve the delivery plan", created_at: "2026-10-04T08:00:00Z" },
      },
    ];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    const link = screen.getByRole("link", { name: /Approve the delivery plan/ });
    expect(link).toHaveAttribute("href", "/w/w1/p/p1?tab=decisions");
    expect(screen.getByText("Clinic booking")).toBeInTheDocument();
  });

  it("says when nothing is waiting", () => {
    items = [];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    expect(screen.getByText(/Nothing is waiting on you/)).toBeInTheDocument();
  });
});
