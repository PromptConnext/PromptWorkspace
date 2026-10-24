import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCard as Card, WorkspaceMember } from "@/lib/types";
import { ProjectCard } from "./ProjectCard";

const useCloudGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hooks", () => ({ useCloudGet }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({}) }),
}));
const NOW = new Date("2026-10-24T12:00:00Z");
beforeEach(() => {
  useCloudGet.mockReset();
  useCloudGet.mockReturnValue({ data: null, error: null, loading: false });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function member(id: string, email: string, name: string | null = null): WorkspaceMember {
  return {
    workspace_id: "w1",
    user_id: id,
    email,
    display_name: name,
    role: "member",
    invited_by: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}
const members = [
  member("u1", "somchai@x.co", "Somchai"),
  member("u2", "ann@x.co", "Ann"),
  member("u3", "bo@x.co"),
  member("u4", "cy@x.co"),
  member("u5", "di@x.co"),
  member("u6", "ed@x.co"),
  member("u7", "flo@x.co"),
];

function card(over: Partial<Card> = {}): Card {
  return {
    id: "p1",
    name: "Billing",
    lifecycle_status: "repo_created",
    live_url: null,
    updated_at: "2026-10-24T10:00:00Z",
    hats: { business_owner: "u2", tech_steward: "u1" },
    contributors: [],
    task_counts: { todo: 4, in_progress: 3, implemented: 10, verified: 2 },
    decisions: { open: 2, overdue: 0, expired_30d: 0 },
    stack: { runtime: "Node", languages: ["TypeScript", "Python", "Go", "Rust"] },
    policy: { source: "workspace", selected: [], require_seeded_rules: true },
    checks: [{ id: "c1", ok: true, text: "All good" }],
    agent_closed_30d: 0,
    last_activity_at: "2026-10-24T10:00:00Z",
    ...over,
  };
}
function renderCard(c: Card, isAdmin = false) {
  return render(<ProjectCard card={c} members={members} workspaceId="w1" isAdmin={isAdmin} />);
}

describe("ProjectCard", () => {
  it("leads with people: hat holders then contributors", () => {
    renderCard(card({ contributors: ["u1", "u2", "u3", "u4", "u5", "u6", "u7"] }));
    expect(screen.getByText("Somchai")).toBeInTheDocument();
    expect(screen.getByText("(Tech steward)")).toBeInTheDocument();
    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.getByText("(Business owner)")).toBeInTheDocument();
    expect(screen.getByTestId("contributors").children).toHaveLength(6); // five avatars + "+2"
    expect(screen.getByTestId("contributors")).toHaveTextContent(/^.*\+2$/);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("hat with no holder reads No tech steward and links to settings for admins", () => {
    const c = card({ hats: { business_owner: "u2", tech_steward: null } });
    const { unmount } = renderCard(c, true);
    const link = screen.getByRole("link", { name: "No tech steward" });
    expect(link).toHaveAttribute("href", "/w/w1/p/p1/settings");
    expect(link.className).toContain("amber");
    unmount();
    renderCard(c, false);
    expect(screen.getByText("No tech steward")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "No tech steward" })).toBeNull();
  });

  it("hat with no business owner reads No business owner, plain text for members", () => {
    const c = card({ hats: { business_owner: null, tech_steward: "u1" } });
    const { unmount } = renderCard(c, true);
    expect(screen.getByRole("link", { name: "No business owner" })).toHaveAttribute(
      "href",
      "/w/w1/p/p1/settings",
    );
    unmount();
    renderCard(c, false);
    const text = screen.getByText("No business owner");
    expect(text.className).toContain("amber");
    expect(screen.queryByRole("link", { name: "No business owner" })).toBeNull();
  });

  it("hat holder missing from members renders Unknown member", () => {
    renderCard(card({ hats: { business_owner: null, tech_steward: "gone-id" } }));
    expect(screen.getByText("Unknown member")).toBeInTheDocument();
    expect(screen.queryByText(/gone-id/)).toBeNull();
  });

  it("unknown contributor renders Unknown member", () => {
    renderCard(card({ contributors: ["ghost-id"] }));
    expect(screen.getAllByTitle("Unknown member").length).toBeGreaterThan(0);
    expect(screen.queryByText(/ghost-id/)).toBeNull();
  });

  it("stack line shows runtime and up to three languages, or Not analysed yet", () => {
    const { unmount } = renderCard(card());
    expect(screen.getByText("Node")).toBeInTheDocument();
    expect(screen.getByText("Go")).toBeInTheDocument();
    expect(screen.queryByText("Rust")).toBeNull();
    unmount();
    renderCard(card({ stack: null }));
    expect(screen.getByText("Not analysed yet")).toBeInTheDocument();
  });

  it("state line: 3 in progress · 12 done · 2 decisions waiting", () => {
    renderCard(card());
    const line = screen.getByRole("link", { name: "2 decisions waiting" }).parentElement!;
    expect(line.textContent).toBe("3 in progress · 12 done · 2 decisions waiting");
    const link = screen.getByRole("link", { name: "2 decisions waiting" });
    expect(link).toHaveAttribute("href", "/w/w1/p/p1?tab=decisions");
  });

  it("card state line appends · N closed by agents when agent_closed_30d > 0", () => {
    const { unmount } = renderCard(card({ agent_closed_30d: 7 }));
    const link = screen.getByRole("link", { name: "2 decisions waiting" });
    expect(link.parentElement!.textContent).toBe(
      "3 in progress · 12 done · 2 decisions waiting · 7 closed by agents",
    );
    unmount();
    renderCard(card({ agent_closed_30d: 1 }));
    expect(screen.getByText(/· 1 closed by agents/)).toBeInTheDocument();
    cleanup();
    renderCard(card({ agent_closed_30d: 0 }));
    expect(screen.queryByText(/closed by agents/)).toBeNull();
  });

  it("overdue decision turns amber: 1 decision overdue", () => {
    renderCard(card({ decisions: { open: 2, overdue: 1, expired_30d: 1 } }));
    const link = screen.getByRole("link", { name: "1 decision overdue" });
    expect(link.className).toContain("amber");
    expect(screen.queryByText(/waiting/)).toBeNull();
    expect(screen.getByText("1 decision expired without an answer").className).toContain("amber");
  });

  it("governance line: Follows workspace rules when all checks pass, else first failing sentence", () => {
    const { unmount } = renderCard(card());
    expect(screen.getByText("Follows workspace rules")).toBeInTheDocument();
    unmount();
    renderCard(
      card({
        checks: [
          { id: "a", ok: true, text: "fine" },
          { id: "b", ok: false, text: "No tests run on pull requests." },
          { id: "c", ok: false, text: "Second failure." },
        ],
      }),
    );
    expect(screen.getByText("No tests run on pull requests.").className).toContain("amber");
    expect(screen.queryByText("Second failure.")).toBeNull();
    expect(screen.queryByText("Follows workspace rules")).toBeNull();
  });

  it("Live pill links to live_url", () => {
    renderCard(card({ live_url: "https://app.example.com" }));
    const pill = screen.getByRole("link", { name: /Live/ });
    expect(pill).toHaveAttribute("href", "https://app.example.com");
    expect(within(document.body).getByText(/Updated 2 hours ago/)).toBeInTheDocument();
  });

  const DRIFT = "Rules in the repository differ from the plan";
  const docsPath = "/projects/p1/repository/docs-status";
  function mockDocs(files: { path: string; state: string }[]) {
    useCloudGet.mockImplementation((path: string | null, enabled = true) =>
      path === docsPath && enabled
        ? { data: { files, open_sync_pr: null }, error: null, loading: false }
        : { data: null, error: null, loading: false },
    );
  }

  it("repo_created project fetches docs-status and shows Rules in the repository differ from the plan when any file is not current", () => {
    mockDocs([
      { path: "AGENTS.md", state: "current" },
      { path: "CLAUDE.md", state: "out_of_date" },
    ]);
    renderCard(card());
    expect(useCloudGet).toHaveBeenCalledWith(docsPath, true);
    expect(screen.getByText(DRIFT).className).toContain("amber");
    expect(screen.queryByText("Follows workspace rules")).toBeNull();
  });

  it("all files current keeps Follows workspace rules; a server failing check outranks drift", () => {
    mockDocs([{ path: "AGENTS.md", state: "current" }]);
    const { unmount } = renderCard(card());
    expect(screen.getByText("Follows workspace rules")).toBeInTheDocument();
    unmount();
    mockDocs([{ path: "AGENTS.md", state: "out_of_date" }]);
    renderCard(card({ checks: [{ id: "b", ok: false, text: "No tests run on pull requests." }] }));
    expect(screen.getByText("No tests run on pull requests.")).toBeInTheDocument();
    expect(screen.queryByText(DRIFT)).toBeNull();
  });

  it("planning project does not fetch docs-status", () => {
    renderCard(card({ lifecycle_status: "planning" }));
    expect(useCloudGet).toHaveBeenCalledWith(docsPath, false);
    expect(useCloudGet).not.toHaveBeenCalledWith(docsPath, true);
  });

  it("drift check is skipped when governance.require_seeded_rules is false", () => {
    mockDocs([{ path: "AGENTS.md", state: "out_of_date" }]);
    renderCard(card({ policy: { source: "workspace", selected: [], require_seeded_rules: false } }));
    expect(useCloudGet).toHaveBeenCalledWith(docsPath, false);
    expect(screen.queryByText(DRIFT)).toBeNull();
  });
});
