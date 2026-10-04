import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { email: "someone.with.a.long@example.com" }, signOut: vi.fn() }),
}));
const setActiveWorkspace = vi.fn();
const createWorkspace = vi.fn();
let memberships: { id: string; name: string }[] = [];
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    memberships,
    activeWorkspace: memberships[0] ?? null,
    setActiveWorkspace,
    clearActiveWorkspace: vi.fn(),
    createWorkspace,
  }),
}));

afterEach(() => {
  cleanup();
  memberships = [];
  vi.resetAllMocks();
});

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

describe("TopBar workspace switcher: new workspace", () => {
  async function openSwitcher() {
    memberships = [{ id: "w1", name: "Acme" }];
    render(<TopBar />);
    await userEvent.click(screen.getByRole("combobox", { name: "Active workspace" }));
  }

  it("offers a last 'New workspace…' item that opens the dialog without navigating", async () => {
    await openSwitcher();
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveTextContent("New workspace…");
    await userEvent.click(screen.getByRole("option", { name: "New workspace…" }));
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });

  it("creates the workspace and navigates to it", async () => {
    createWorkspace.mockResolvedValue({ id: "w2", name: "Globex" });
    await openSwitcher();
    await userEvent.click(screen.getByRole("option", { name: "New workspace…" }));
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await userEvent.type(within(dialog).getByLabelText(/workspace name/i), "Globex");
    await userEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith("Globex"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/w/w2"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a create failure and does not navigate", async () => {
    createWorkspace.mockRejectedValue(new Error("nope"));
    await openSwitcher();
    await userEvent.click(screen.getByRole("option", { name: "New workspace…" }));
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await userEvent.type(within(dialog).getByLabelText(/workspace name/i), "Globex");
    await userEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("nope");
    expect(push).not.toHaveBeenCalled();
  });
});
