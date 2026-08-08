import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReindexPanel } from "./ReindexPanel";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const reindexProject = vi.fn();
const getIndexStatus = vi.fn();
vi.mock("@/lib/api", () => ({
  reindexProject: (...args: unknown[]) => reindexProject(...args),
  getIndexStatus: (...args: unknown[]) => getIndexStatus(...args),
}));

beforeEach(() => {
  // Every test renders the panel, which fetches status on mount — give it a
  // harmless default so tests that don't care about the status display
  // aren't left awaiting an unmocked (undefined-returning) call.
  getIndexStatus.mockResolvedValue({ indexed_chunks: 0, indexable_nodes: 0, embed_model: null });
});

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

  it("renders the fetched status", async () => {
    getIndexStatus.mockResolvedValue({
      indexed_chunks: 12,
      indexable_nodes: 15,
      embed_model: "text-embed-3",
    });
    render(<ReindexPanel projectId="p1" />);
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledWith("p1", expect.anything()));
    expect(await screen.findByText(/12/)).toBeInTheDocument();
    expect(screen.getByText(/15/)).toBeInTheDocument();
    expect(screen.getByText(/text-embed-3/)).toBeInTheDocument();
  });

  it("re-fetches after a successful reindex so the count updates", async () => {
    getIndexStatus
      .mockResolvedValueOnce({ indexed_chunks: 0, indexable_nodes: 5, embed_model: null })
      .mockResolvedValueOnce({ indexed_chunks: 5, indexable_nodes: 5, embed_model: "embed-x" });
    reindexProject.mockResolvedValue({ enqueued: 5 });

    render(<ReindexPanel projectId="p1" />);
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(screen.getByText(/5 items queued/i)).toBeInTheDocument());
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/embed-x/)).toBeInTheDocument();
  });
});
