import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonLink, ProjectCard, WorkspaceMember, WorkspaceOverview } from "@/lib/types";
import { MemberPanel } from "./MemberPanel";

const useCloudGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hooks", () => ({ useCloudGet }));

function member(id: string, name: string): WorkspaceMember {
  return {
    workspace_id: "w1", user_id: id, email: `${id}@x.co`, display_name: name,
    role: "member", invited_by: null, created_at: "2026-01-01T00:00:00Z",
  };
}
const ann = member("u1", "Ann");
const bo = member("u2", "Bo");

const card = (id: string, name: string, inProgress = 0): ProjectCard =>
  ({
    id, name, contributors: [],
    hats: { business_owner: null, tech_steward: null },
    task_counts: { todo: 0, in_progress: inProgress, implemented: 0, verified: 0 },
    decisions: { open: 0, overdue: 0, expired_30d: 0 },
  }) as unknown as ProjectCard;

const link = (p: Partial<PersonLink>): PersonLink => ({
  kind: "hat", from_user_id: "u1", to_user_id: null, project_id: "p1", hat: null, weight: 1, ...p,
});

const overview = (people: PersonLink[]): WorkspaceOverview => ({
  workspace_id: "w1", generated_at: "2026-10-24T00:00:00Z", truncated: false,
  members: [ann, bo],
  projects: [card("p1", "Alpha", 5), card("p2", "Beta", 5), card("p3", "Gamma")],
  people,
});

const PEOPLE = [
  link({ kind: "hat", project_id: "p1", hat: "business_owner" }),
  link({ kind: "work", project_id: "p2", weight: 3 }),
  link({ kind: "hat", from_user_id: "u2", project_id: "p3", hat: "tech_steward" }),
];

const decision = (id: string, hat: string, kind = "intent_approval") => ({
  id, kind, routed_hat: hat, status: "open", title: "t",
});

function mockApi(map: Record<string, unknown>) {
  useCloudGet.mockImplementation((path: string | null, enabled = true) => {
    const data = path && enabled && path in map ? map[path] : null;
    return { data, error: null, loading: false };
  });
}

function panel(over: Partial<React.ComponentProps<typeof MemberPanel>> = {}) {
  return render(
    <MemberPanel
      member={ann} overview={overview(PEOPLE)} viewerIsAdmin={false}
      viewerId="u3" workspaceId="w1" {...over}
    />,
  );
}

beforeEach(() => {
  useCloudGet.mockReset();
  mockApi({});
});
afterEach(cleanup);

describe("MemberPanel", () => {
  it("lists hats per project and projects contributed to", () => {
    panel();
    expect(screen.getByRole("heading", { name: "Ann" })).toBeInTheDocument();
    expect(screen.getByText("Business owner · Alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/w/w1/p/p1");
    expect(screen.getByRole("link", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Gamma" })).not.toBeInTheDocument();
  });

  it("shows empty states", () => {
    panel({ member: bo, overview: overview([]) });
    expect(screen.getByText("No hats")).toBeInTheDocument();
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("shows decisions waiting on the member only to admins or the member themself", () => {
    mockApi({
      "/projects/p1/decisions": {
        decisions: [decision("d1", "business_owner"), decision("d2", "tech_steward")],
      },
    });
    const { unmount } = panel({ viewerIsAdmin: true });
    expect(screen.getByText("Intent approval · Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Plan approval · Alpha")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Intent approval · Alpha" })).toHaveAttribute(
      "href", "/w/w1/p/p1?tab=decisions");
    unmount();

    // another member viewing: no queue, nothing fetched
    useCloudGet.mockClear();
    panel({ viewerIsAdmin: false, viewerId: "u3" });
    expect(screen.queryByText("Decisions waiting")).not.toBeInTheDocument();
    expect(useCloudGet.mock.calls.every(([, enabled]) => enabled === false)).toBe(true);
    cleanup();

    // the member themself
    mockApi({
      "/me/decisions?workspace_id=w1": [
        { decision: decision("d9", "business_owner", "plan_approval"), project_id: "p1", project_name: "Alpha", workspace_id: "w1" },
      ],
    });
    panel({ viewerId: "u1" });
    expect(screen.getByText("Decisions waiting")).toBeInTheDocument();
    expect(screen.getByText("Plan approval · Alpha")).toBeInTheDocument();
  });

  it("tasks in progress count from work edges and card task_counts", () => {
    panel({ overview: overview([...PEOPLE, link({ kind: "work", project_id: "p1", weight: 2 })]) });
    expect(screen.getByText("5 tasks assigned")).toBeInTheDocument();
    cleanup();
    panel({ overview: overview([link({ kind: "work", project_id: "p2", weight: 1 })]) });
    expect(screen.getByText("1 task assigned")).toBeInTheDocument();
  });
});

describe("MemberPanel names and headings", () => {
  beforeEach(() => mockApi({}));
  afterEach(cleanup);

  it("never shows a raw id for a nameless member; section is Assigned", () => {
    const ghost = { ...member("u-raw-id", ""), email: "" } as WorkspaceMember;
    panel({ member: ghost, overview: { ...overview([]), members: [ghost] } });
    expect(screen.getByRole("heading", { name: "Unnamed member" })).toBeInTheDocument();
    expect(screen.queryByText(/u-raw-id/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Assigned" })).toBeInTheDocument();
    expect(screen.queryByText("In progress")).toBeNull();
  });
});

describe("MemberPanel unknown project", () => {
  beforeEach(() => mockApi({}));
  afterEach(cleanup);

  it("a hat on a project outside the overview reads Unknown project, never the id", () => {
    const people = [link({ kind: "hat", project_id: "p-gone-uuid", hat: "tech_steward" })];
    panel({ overview: overview(people) });
    expect(screen.getByText("Tech steward · Unknown project")).toBeInTheDocument();
    expect(screen.queryByText(/p-gone-uuid/)).toBeNull();
  });
});
