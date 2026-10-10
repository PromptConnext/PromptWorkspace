import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubConnectionForm } from "./GithubConnectionForm";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({
    data: { connected: false, owner: null, account_login: null, token_expires_at: null },
    refetch: vi.fn(),
  }),
}));

afterEach(cleanup);

describe("GithubConnectionForm permission copy", () => {
  it("lists Workflows and Pull requests alongside the existing permissions", () => {
    render(<GithubConnectionForm workspaceId="ws1" />);
    for (const name of [
      "Contents",
      "Administration",
      "Webhooks",
      "Secrets",
      "Variables",
      "Workflows",
      "Pull requests",
    ]) {
      expect(screen.getByText(name, { selector: "strong" })).toBeInTheDocument();
    }
  });
});
