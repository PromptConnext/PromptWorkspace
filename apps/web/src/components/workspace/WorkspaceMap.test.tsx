import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonLink, ProjectCard, WorkspaceMember, WorkspaceOverview } from "@/lib/types";
import { WorkspaceMap } from "./WorkspaceMap";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

const m = (id: string, name: string): WorkspaceMember => ({
  workspace_id: "w1", user_id: id, email: `${id}@x.co`, display_name: name,
  role: "member", invited_by: null, created_at: "2026-01-01T00:00:00Z",
});
const card = (id: string, name: string) => ({ id, name }) as unknown as ProjectCard;
const link = (p: Partial<PersonLink>): PersonLink => ({
  kind: "hat", from_user_id: "u1", to_user_id: null, project_id: "p1", hat: null, weight: 1, ...p,
});

const overview = (people: PersonLink[], projects = [card("p1", "Alpha"), card("p2", "Beta")]): WorkspaceOverview => ({
  workspace_id: "w1", generated_at: "2026-10-24T00:00:00Z", truncated: false,
  members: [m("u1", "Somchai"), m("u2", "Ann")],
  projects,
  people,
});

const PEOPLE = [
  link({ kind: "hat", project_id: "p1", hat: "business_owner" }),
  link({ kind: "work", from_user_id: "u2", project_id: "p2", weight: 4 }),
  link({ kind: "approval", from_user_id: "u1", to_user_id: "u2", project_id: null }),
];

describe("WorkspaceMap", () => {
  it("renders one node per member and project and one path per link, hat solid, work thin, approval dashed with arrow", () => {
    const { container } = render(
      <WorkspaceMap overview={overview(PEOPLE)} workspaceId="w1" onSelectMember={() => {}} />,
    );
    expect(screen.getByRole("img", { name: "Workspace map" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/, member$/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/, project$/)).toHaveLength(2);
    const paths = container.querySelectorAll("path[data-edge]");
    expect(paths).toHaveLength(3);
    const hat = container.querySelector('path[data-edge="hat"]')!;
    const work = container.querySelector('path[data-edge="work"]')!;
    const approval = container.querySelector('path[data-edge="approval"]')!;
    expect(hat).not.toHaveAttribute("stroke-dasharray");
    expect(hat).toHaveAttribute("stroke", "#059669");
    expect(Number(work.getAttribute("stroke-width"))).toBeLessThanOrEqual(4);
    expect(Number(work.getAttribute("stroke-width"))).toBeGreaterThanOrEqual(1);
    expect(Number(hat.getAttribute("stroke-width"))).toBeGreaterThan(0);
    expect(approval).toHaveAttribute("stroke-dasharray");
    expect(approval.getAttribute("marker-end")).toMatch(/^url\(#/);
  });

  it("hover highlights the node's edges; Enter on a focused project node navigates", () => {
    const { container } = render(
      <WorkspaceMap overview={overview(PEOPLE)} workspaceId="w1" onSelectMember={() => {}} />,
    );
    const alpha = screen.getByLabelText("Alpha, project");
    fireEvent.mouseEnter(alpha);
    expect(container.querySelector('path[data-edge="hat"]')).toHaveAttribute("opacity", "1");
    expect(container.querySelector('path[data-edge="work"]')).toHaveAttribute("opacity", "0.25");
    expect(screen.getByLabelText("Somchai, member")).toHaveAttribute("opacity", "1");
    expect(screen.getByLabelText("Beta, project")).toHaveAttribute("opacity", "0.25");
    fireEvent.mouseLeave(alpha);
    expect(screen.getByLabelText("Beta, project")).toHaveAttribute("opacity", "1");
    expect(container.querySelector('path[data-edge="work"]')).toHaveAttribute("opacity", "1");
    fireEvent.keyDown(alpha, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/w/w1/p/p1");
  });

  it("selects a member on click and shows an empty state with nothing to map", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <WorkspaceMap overview={overview(PEOPLE)} workspaceId="w1" onSelectMember={onSelect} />,
    );
    fireEvent.click(screen.getByLabelText("Somchai, member"));
    expect(onSelect).toHaveBeenCalledWith("u1");
    rerender(<WorkspaceMap overview={overview([], [])} workspaceId="w1" onSelectMember={onSelect} />);
    expect(screen.getByText("Nothing to map yet")).toBeInTheDocument();
  });
});

describe("WorkspaceMap names", () => {
  it("labels a nameless member Unnamed member, not the raw id", () => {
    const ghost = { ...m("u-raw-id", ""), email: "" } as WorkspaceMember;
    const ov = { ...overview([]), members: [ghost] };
    render(<WorkspaceMap overview={ov} workspaceId="w1" onSelectMember={() => {}} />);
    expect(screen.getByLabelText("Unnamed member, member")).toBeInTheDocument();
    expect(screen.queryByLabelText(/u-raw-id/)).toBeNull();
  });
});

describe("WorkspaceMap unknown project", () => {
  it("a link to a project missing from the overview is not labelled with its id", () => {
    const ov = overview([link({ kind: "hat", project_id: "p-gone-uuid", hat: "business_owner" })]);
    render(<WorkspaceMap overview={ov} workspaceId="w1" onSelectMember={() => {}} />);
    expect(screen.queryByLabelText(/p-gone-uuid/)).toBeNull();
  });
});
