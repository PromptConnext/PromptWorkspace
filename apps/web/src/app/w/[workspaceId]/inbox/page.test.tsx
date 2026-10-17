import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InboxPage from "./page";

let items: unknown[] | null = [];
let error: string | null = null;
let loading = false;
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
  useCloudGet: () => ({ data: items, error, loading, refetch: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  items = [];
  error = null;
  loading = false;
});

describe("Inbox", () => {
  it("links each waiting decision to its project's Decisions tab", () => {
    items = [
      {
        project_id: "p1", project_name: "Clinic booking", workspace_id: "w1", workspace_name: "WS",
        decision: { id: "d1", status: "open", title: "Approve the delivery plan", created_at: "2026-10-04T08:00:00Z" },
      },
    ];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    const link = screen.getByRole("link", { name: /Approve the delivery plan/ });
    expect(link).toHaveAttribute("href", "/w/w1/p/p1?tab=decisions");
    expect(screen.getByText("Clinic booking")).toBeInTheDocument();
  });

  it("clicking anywhere on an inbox card navigates", () => {
    items = [
      {
        project_id: "p1", project_name: "Clinic booking", workspace_id: "w1", workspace_name: "WS",
        decision: { id: "d1", status: "open", title: "Approve the delivery plan", created_at: "2026-10-04T08:00:00Z" },
      },
    ];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);

    // The project name and the date are not the title, but they sit inside the link.
    const href = "/w/w1/p/p1?tab=decisions";
    expect(screen.getByText("Clinic booking").closest("a")).toHaveAttribute("href", href);
    expect(screen.getByText(/2026|10/).closest("a")).toHaveAttribute("href", href);
    expect(screen.getByRole("listitem")).toBe(screen.getByRole("link").parentElement);
  });

  it("lists decisions sent back to the requester with the reason", () => {
    items = [
      {
        project_id: "p1", project_name: "Clinic booking", workspace_id: "w1", workspace_name: "WS",
        decision: {
          id: "d2", status: "rejected", title: "Approve the intent", rationale: "Add cancellations.",
          created_at: "2026-10-04T08:00:00Z",
        },
      },
    ];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);

    expect(screen.getByRole("heading", { name: "Sent back to you" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Approve the intent/ });
    expect(link).toHaveAttribute("href", "/w/w1/p/p1?tab=decisions");
    expect(link).toHaveTextContent("Clinic booking");
    expect(link).toHaveTextContent("Add cancellations.");
    expect(screen.getByText(/Nothing is waiting on you/)).toBeInTheDocument();
  });

  it("has no Sent back section when nothing was sent back", () => {
    items = [];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    expect(screen.queryByText("Sent back to you")).not.toBeInTheDocument();
  });

  it("says when nothing is waiting", () => {
    items = [];
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    expect(screen.getByText(/Nothing is waiting on you/)).toBeInTheDocument();
  });

  it("shows Loading… while the first fetch is in flight", () => {
    items = null;
    loading = true;
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the error as an alert", () => {
    items = null;
    error = "Could not load decisions";
    render(<InboxPage params={Promise.resolve({ workspaceId: "w1" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load decisions");
  });
});
