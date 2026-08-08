import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReindexPanel } from "./ReindexPanel";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const reindexProject = vi.fn();
vi.mock("@/lib/api", () => ({
  reindexProject: (...args: unknown[]) => reindexProject(...args),
}));

afterEach(() => {
  // No global auto-cleanup in this repo — see the other component test files.
  cleanup();
  vi.resetAllMocks();
});

describe("ReindexPanel", () => {
  it("asks for confirmation before spending on embeddings", async () => {
    render(<ReindexPanel projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    expect(reindexProject).not.toHaveBeenCalled();
    expect(screen.getByText(/one embedding call/i)).toBeInTheDocument();
  });

  it("reports the enqueued count using the server's number", async () => {
    reindexProject.mockResolvedValue({ enqueued: 142 });
    render(<ReindexPanel projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText(/142 items queued/i)).toBeInTheDocument());
  });

  it("surfaces a failure without claiming anything was queued", async () => {
    reindexProject.mockRejectedValue(new Error("forbidden"));
    render(<ReindexPanel projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
  });
});
