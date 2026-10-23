import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxLink } from "./InboxLink";

let items: unknown[] | null = [];
const requested: string[] = [];
vi.mock("@/lib/hooks", () => ({
  useCloudGet: (path: string) => {
    requested.push(path);
    return { data: items, error: null, loading: false, refetch: vi.fn() };
  },
}));
afterEach(() => {
  cleanup();
  items = [];
  requested.length = 0;
});

describe("InboxLink", () => {
  it("counts waiting and sent-back decisions", () => {
    items = [
      { decision: { id: "d1", status: "open" } },
      { decision: { id: "d2", status: "rejected" } },
    ];
    render(<InboxLink workspaceId="w1" />);
    expect(screen.getByRole("link", { name: "Inbox · 2" })).toHaveAttribute("href", "/w/w1/inbox");
  });

  it("shows plain Inbox when nothing waits", () => {
    items = [];
    render(<InboxLink workspaceId="w1" />);
    expect(screen.getByRole("link", { name: "Inbox" })).toBeInTheDocument();
  });

  it("requests the sent-back items", () => {
    render(<InboxLink workspaceId="w1" />);
    expect(requested[0]).toMatch(/&include_mine=true$/);
  });
});
