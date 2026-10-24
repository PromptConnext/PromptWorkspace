import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResetPasswordPage from "./page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  AUTH_MODE: "supabase",
}));

const updatePassword = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "me@example.com" },
    loading: false,
    updatePassword,
    authHeaders: () => ({ authorization: "Bearer tok" }),
  }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  revokeAllOauthGrants: (headers: Record<string, string>) =>
    apiFetch("/me/oauth-grants", headers, { method: "DELETE" }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function submit() {
  render(<ResetPasswordPage />);
  await userEvent.type(screen.getByLabelText("New password"), "s3cret-pass");
  await userEvent.type(screen.getByLabelText("Confirm new password"), "s3cret-pass");
  await userEvent.click(screen.getByRole("button", { name: "Update password" }));
}

describe("reset password", () => {
  it("revokes every connected agent after a successful reset", async () => {
    updatePassword.mockResolvedValue(undefined);
    apiFetch.mockResolvedValue(undefined);
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(apiFetch).toHaveBeenCalledWith("/me/oauth-grants", { authorization: "Bearer tok" }, { method: "DELETE" });
  });

  it("still completes when the revoke call fails", async () => {
    updatePassword.mockResolvedValue(undefined);
    apiFetch.mockRejectedValue(new Error("offline"));
    await submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("does not revoke when the reset fails", async () => {
    updatePassword.mockRejectedValue(new Error("weak password"));
    await submit();
    expect(await screen.findByText("weak password")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
