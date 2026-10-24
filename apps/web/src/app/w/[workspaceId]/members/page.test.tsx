import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembersPage from "./page";

const UUID = "3f2b8c1e-9d4a-4e0b-8a77-5c1d2e3f4a5b";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/w1/members",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/InviteForm", () => ({ InviteForm: () => null }));
vi.mock("@/components/PendingInvitations", () => ({ PendingInvitations: () => null }));
vi.mock("@/components/DisplayNameField", () => ({ DisplayNameField: () => null }));
vi.mock("@/components/workspace/MemberPanel", () => ({ MemberPanel: () => null }));
vi.mock("@/components/workspace/WorkspaceMap", () => ({ WorkspaceMap: () => null }));
vi.mock("@/components/workspace/useOverview", () => ({
  useOverview: () => ({ data: null, error: null, loading: false }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-1" } }) }));
vi.mock("@/lib/workspace", () => ({ useWorkspaceName: () => "Acme" }));
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({
    data: [
      {
        workspace_id: "w1", user_id: "admin-1", email: "boss@x.co", display_name: "Boss",
        role: "admin", invited_by: null, created_at: "2026-01-01T00:00:00Z",
      },
      {
        workspace_id: "w1", user_id: UUID, email: null, display_name: null,
        role: "member", invited_by: null, created_at: "2026-01-01T00:00:00Z",
      },
    ],
    error: null,
    loading: false,
    refetch: vi.fn(),
  }),
}));

const params = Object.assign(Promise.resolve({ workspaceId: "w1" }), {
  status: "fulfilled",
  value: { workspaceId: "w1" },
});

afterEach(cleanup);

describe("members page", () => {
  it("never shows a raw user id for a member with no name or email", async () => {
    const { container } = render(
      <Suspense fallback={null}>
        <MembersPage params={params} />
      </Suspense>,
    );
    await act(async () => {
      await params;
    });
    expect(screen.getByRole("button", { name: "Show details for Unnamed member" })).toHaveTextContent(
      "Unnamed member",
    );
    expect(screen.getByRole("button", { name: "Edit name of Unnamed member" })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(UUID);
  });
});
