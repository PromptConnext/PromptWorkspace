import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthGrantOut } from "@/lib/types";
import ConnectedAgentsPage from "./page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ authorization: "Bearer tok" }) }),
}));

const listOauthGrants = vi.fn();
const revokeOauthGrant = vi.fn();
const revokeAllOauthGrants = vi.fn();
vi.mock("@/lib/api", () => ({
  listOauthGrants: (...a: unknown[]) => listOauthGrants(...a),
  revokeOauthGrant: (...a: unknown[]) => revokeOauthGrant(...a),
  revokeAllOauthGrants: (...a: unknown[]) => revokeAllOauthGrants(...a),
}));

const H = { authorization: "Bearer tok" };

function grant(over: Partial<OAuthGrantOut>): OAuthGrantOut {
  return {
    family_id: "f1",
    client_id: "c1",
    client_name: "Claude Code",
    vendor: "Anthropic",
    verified: true,
    created_at: "2026-10-20T10:00:00Z",
    last_used_at: "2026-10-24T10:00:00Z",
    revoked_at: null,
    ...over,
  };
}

const grants = [
  grant({}),
  grant({ family_id: "f2", client_id: "c2", client_name: "My Script", vendor: null, verified: false, last_used_at: null }),
  grant({ family_id: "f3", client_id: "c3", client_name: "Old Agent", revoked_at: "2026-10-22T00:00:00Z" }),
];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function renderPage() {
  await act(async () => {
    render(<ConnectedAgentsPage />);
  });
}

function rowOf(name: string) {
  return screen.getByText(name).closest("tr")!;
}

describe("Connected agents page", () => {
  it("lists grants with verification and status", async () => {
    listOauthGrants.mockResolvedValue(grants);
    await renderPage();
    expect(listOauthGrants).toHaveBeenCalledWith(H);
    const claude = rowOf("Claude Code");
    expect(within(claude).getByText("Anthropic")).toBeInTheDocument();
    expect(within(claude).getByText("Verified")).toBeInTheDocument();
    expect(within(claude).getByText("Active")).toBeInTheDocument();
    expect(within(claude).getByRole("button", { name: "Revoke" })).toBeInTheDocument();

    const script = rowOf("My Script");
    expect(within(script).getByText("Unverified")).toBeInTheDocument();
    expect(within(script).getByText("Never")).toBeInTheDocument();

    const old = rowOf("Old Agent");
    expect(within(old).getByText("Revoked")).toBeInTheDocument();
    expect(within(old).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    listOauthGrants.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByText("No agents are connected to your account.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke all" })).not.toBeInTheDocument();
  });

  it("revokes one grant and reloads", async () => {
    listOauthGrants.mockResolvedValueOnce(grants).mockResolvedValueOnce([
      grant({ revoked_at: "2026-10-25T00:00:00Z" }),
      grants[1],
      grants[2],
    ]);
    revokeOauthGrant.mockResolvedValue(undefined);
    await renderPage();
    await userEvent.click(within(rowOf("Claude Code")).getByRole("button", { name: "Revoke" }));
    expect(revokeOauthGrant).toHaveBeenCalledWith("f1", H);
    await waitFor(() => expect(within(rowOf("Claude Code")).getByText("Revoked")).toBeInTheDocument());
  });

  it("revokes all only after a second click", async () => {
    listOauthGrants.mockResolvedValueOnce(grants).mockResolvedValueOnce(
      grants.map((g) => ({ ...g, revoked_at: g.revoked_at ?? "2026-10-25T00:00:00Z" })),
    );
    revokeAllOauthGrants.mockResolvedValue(undefined);
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke all" }));
    expect(revokeAllOauthGrants).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm: revoke all" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Revoke all" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm: revoke all" }));
    expect(revokeAllOauthGrants).toHaveBeenCalledWith(H);
    await waitFor(() => expect(screen.queryAllByText("Active")).toHaveLength(0));
  });

  it("disables Cancel while revoke all is in flight", async () => {
    listOauthGrants.mockResolvedValue(grants);
    let finish: () => void = () => {};
    revokeAllOauthGrants.mockReturnValue(new Promise<void>((r) => (finish = r)));
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke all" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm: revoke all" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => finish());
  });

  it("shows a load error", async () => {
    listOauthGrants.mockRejectedValue(new Error("boom"));
    await renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });
});
