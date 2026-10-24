import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernancePanel } from "./GovernancePanel";

const refetch = vi.fn();
const putGovernance = vi.fn();

const GOV = {
  workspace_id: "w1",
  policy_scope: { selected: ["gdpr"], custom_text: "" },
  required_hats: ["business_owner", "tech_steward"],
  require_seeded_rules: true,
  updated_by: null,
  updated_at: "2026-10-24T00:00:00Z",
};
const REPORT = {
  projects: [
    {
      project_id: "p1",
      name: "Alpha",
      checks: [
        { id: "hat_tech_steward", ok: false, text: "No tech steward assigned" },
        { id: "policy_matches_workspace", ok: false, text: "Policy scope differs from the workspace" },
        { id: "decisions_overdue", ok: false, text: "1 decision past its due date" },
        { id: "hat_business_owner", ok: true, text: "Has a business owner assigned" },
      ],
    },
    {
      project_id: "p2",
      name: "Beta",
      checks: [{ id: "hat_business_owner", ok: true, text: "Has a business owner assigned" }],
    },
  ],
};
const card = (id: string, name: string, source: "workspace" | "project") => ({
  id, name, policy: { source, selected: [], require_seeded_rules: true },
});
const OVERVIEW = {
  projects: [card("p1", "Alpha", "project"), card("p2", "Beta", "workspace"), card("p3", "Gamma", "workspace")],
};
const TEMPLATES = [
  { id: "gdpr", name: "GDPR", description: "EU rules.", body: "body" },
  { id: "thai-pdpa", name: "Thai PDPA", description: "Thai rules.", body: "body" },
];

vi.mock("@/lib/hooks", () => ({
  useCloudGet: (path: string) => {
    let data: unknown = null;
    if (path.endsWith("/governance/report")) data = REPORT;
    else if (path.endsWith("/governance")) data = GOV;
    else if (path.endsWith("/overview")) data = OVERVIEW;
    else if (path === "/policy-templates") data = TEMPLATES;
    return { data, error: null, loading: false, refetch };
  },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ authHeaders: () => ({}) }) }));
vi.mock("@/lib/api", () => ({
  putGovernance: (...a: unknown[]) => putGovernance(...a),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("GovernancePanel", () => {
  it("renders the scope editor, two switches on by default, and a project row per project with its check sentences", () => {
    render(<GovernancePanel workspaceId="w1" />);
    expect(screen.getByText("AI governance")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /gdpr/i })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Every project needs a business owner and a tech steward" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Every project's repository must carry its rules" }),
    ).toBeChecked();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText(/No tech steward assigned/)).toBeInTheDocument();
    expect(screen.queryByText(/Has a business owner assigned/)).not.toBeInTheDocument();
    const links = screen.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);
    expect(links).toEqual([
      ["Assign roles", "/w/w1/p/p1/settings"],
      ["Review policy scope", "/w/w1/p/p1?tab=planner"],
      ["Open decisions", "/w/w1/p/p1?tab=decisions"],
    ]);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Follows workspace rules")).toBeInTheDocument();
  });

  it("Applies to N projects. M projects use their own scope. names the deviating projects", () => {
    render(<GovernancePanel workspaceId="w1" />);
    expect(
      screen.getByText("Applies to 2 projects. 1 project uses its own scope: Alpha."),
    ).toBeInTheDocument();
  });

  it("saving calls putGovernance once with the edited scope and switches", async () => {
    putGovernance.mockResolvedValue(GOV);
    render(<GovernancePanel workspaceId="w1" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /thai pdpa/i }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Every project's repository must carry its rules" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putGovernance).toHaveBeenCalledTimes(1));
    expect(putGovernance.mock.calls[0][0]).toBe("w1");
    expect(putGovernance.mock.calls[0][1]).toEqual({
      policy_scope: { selected: ["gdpr", "thai-pdpa"], custom_text: "" },
      required_hats: ["business_owner", "tech_steward"],
      require_seeded_rules: false,
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("turning the owner switch off saves no required hats", async () => {
    putGovernance.mockResolvedValue(GOV);
    render(<GovernancePanel workspaceId="w1" />);
    fireEvent.click(
      screen.getByRole("switch", { name: "Every project needs a business owner and a tech steward" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putGovernance).toHaveBeenCalledTimes(1));
    expect(putGovernance.mock.calls[0][1].required_hats).toEqual([]);
  });

  it("shows the mapped sentence when the save is rejected", async () => {
    putGovernance.mockRejectedValue(new Error("custom_text_too_long"));
    render(<GovernancePanel workspaceId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/keep it under 20,000 characters/i)).toBeInTheDocument();
  });
});
