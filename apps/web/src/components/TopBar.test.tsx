import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { email: "someone.with.a.long@example.com" }, signOut: vi.fn() }),
}));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    memberships: [],
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
    clearActiveWorkspace: vi.fn(),
  }),
}));

afterEach(cleanup);

describe("TopBar responsiveness", () => {
  it("hides intermediate crumbs below sm but always shows the last, truncated", () => {
    render(
      <TopBar
        crumbs={[
          { label: "Workspace", href: "/w/1" },
          { label: "A very long project name indeed" },
        ]}
      />,
    );
    const [first, last] = screen.getAllByTestId("crumb");
    expect(first).toHaveClass("hidden", "sm:flex");
    expect(last).toHaveClass("flex");
    expect(last).not.toHaveClass("hidden");
    const label = screen.getByText("A very long project name indeed");
    expect(label).toHaveClass("truncate");
    expect(label).toHaveAttribute("title", "A very long project name indeed");
  });

  it("hides the email below md but keeps Sign out", () => {
    render(<TopBar />);
    expect(screen.getByText("someone.with.a.long@example.com")).toHaveClass("hidden", "md:inline");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("keeps the loading crumb skeleton", () => {
    render(<TopBar crumbs={[{ label: "Project", loading: true }]} />);
    expect(screen.getByTestId("crumb-skeleton")).toBeInTheDocument();
  });
});
