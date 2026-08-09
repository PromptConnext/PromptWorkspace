import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus } from "@/lib/types";
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

const IDLE: IndexStatus = {
  indexed_chunks: 0,
  indexable_nodes: 0,
  embed_model: null,
  pending_jobs: 0,
  last_error: null,
};

beforeEach(() => {
  // Every test renders the panel, which fetches status on mount — give it a
  // harmless default so tests that don't care about the status display
  // aren't left awaiting an unmocked (undefined-returning) call.
  getIndexStatus.mockResolvedValue(IDLE);
});

afterEach(() => {
  // No global auto-cleanup in this repo — see the other component test files.
  cleanup();
  // Unconditional: a fake-timer test that fails mid-way would otherwise leave
  // them installed and hang every test after it.
  vi.useRealTimers();
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
      ...IDLE,
      indexed_chunks: 12,
      indexable_nodes: 15,
      embed_model: "text-embed-3",
    });
    render(<ReindexPanel projectId="p1" />);
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledWith("p1", expect.anything()));
    // Assert against the whole status line, not bare numbers: the "checked
    // HH:MM:SS" timestamp shares this paragraph and its digits would satisfy
    // a loose /15/ twice over.
    const line = await screen.findByText(/chunks indexed/i);
    expect(line).toHaveTextContent("12 chunks indexed with text-embed-3");
    expect(line).toHaveTextContent("15 items indexable");
  });

  it("re-fetches after a successful reindex so the count updates", async () => {
    getIndexStatus
      .mockResolvedValueOnce({ ...IDLE, indexable_nodes: 5 })
      .mockResolvedValueOnce({
        ...IDLE,
        indexed_chunks: 5,
        indexable_nodes: 5,
        embed_model: "embed-x",
      });
    reindexProject.mockResolvedValue({ enqueued: 5 });

    render(<ReindexPanel projectId="p1" />);
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(screen.getByText(/5 items queued/i)).toBeInTheDocument());
    await waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/embed-x/)).toBeInTheDocument();
  });

  it("shows a loader instead of an empty gap while the first status is in flight", async () => {
    // The gap is what invited a blind Reindex click: no counts, no spinner,
    // an enabled button. Hold the fetch open to assert on that window.
    let resolveStatus: (s: IndexStatus) => void = () => {};
    getIndexStatus.mockReturnValue(
      new Promise<IndexStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );

    render(<ReindexPanel projectId="p1" />);
    expect(screen.getByText(/checking index status/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reindex project/i })).toBeDisabled();

    resolveStatus({ ...IDLE, indexable_nodes: 3 });
    await waitFor(() =>
      expect(screen.queryByText(/checking index status/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /reindex project/i })).toBeEnabled();
  });

  it("reports the live queue depth and blocks a duplicate sweep while it drains", async () => {
    getIndexStatus.mockResolvedValue({ ...IDLE, indexable_nodes: 4, pending_jobs: 4 });

    render(<ReindexPanel projectId="p1" />);
    expect(await screen.findByText(/4 items left in the queue/i)).toBeInTheDocument();
    // Disabled, not merely discouraged: pressing again enqueues a second full
    // sweep and pays for every embedding twice.
    expect(screen.getByRole("button", { name: /indexing/i })).toBeDisabled();
  });

  it("polls until the queue empties, then stops", async () => {
    vi.useFakeTimers();
    try {
      getIndexStatus
        .mockResolvedValueOnce({ ...IDLE, indexable_nodes: 2, pending_jobs: 2 })
        .mockResolvedValueOnce({ ...IDLE, indexable_nodes: 2, pending_jobs: 1 })
        .mockResolvedValue({ ...IDLE, indexed_chunks: 6, indexable_nodes: 2, pending_jobs: 0 });

      render(<ReindexPanel projectId="p1" />);
      // Wait on the rendered depth, not just the spy: the interval is armed by
      // the effect that runs after that state lands, so advancing the clock
      // earlier would tick a timer that doesn't exist yet.
      await vi.waitFor(() => expect(screen.getByText(/2 items left in the queue/i)).toBeTruthy());

      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(screen.getByText(/1 item left in the queue/i)).toBeTruthy());
      expect(getIndexStatus).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2000);
      // Wait for the empty queue to render, not just for the fetch to fire —
      // the interval is torn down by the effect reacting to pending === 0.
      await vi.waitFor(() => expect(screen.queryByText(/left in the queue/i)).toBeNull());
      const callsWhenDrained = getIndexStatus.mock.calls.length;

      // Queue reported empty — no further polling, and the panel is usable again.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getIndexStatus).toHaveBeenCalledTimes(callsWhenDrained);
      expect(screen.getByRole("button", { name: /reindex project/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling briefly after a reindex even when the queue already reads empty", async () => {
    // A 19-item backfill can drain between the enqueue and the first status
    // read. Without the settle window the panel would show pre-sweep numbers
    // and never look again — which reads as "the button did nothing".
    vi.useFakeTimers();
    try {
      getIndexStatus.mockResolvedValue({ ...IDLE, indexable_nodes: 19 });
      reindexProject.mockResolvedValue({ enqueued: 19 });

      render(<ReindexPanel projectId="p1" />);
      // Wait for the button to leave its loading-disabled state — a click on a
      // disabled button is silently dropped.
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: /reindex project/i })).toBeEnabled(),
      );

      // fireEvent, not userEvent: userEvent's own internal delays deadlock
      // against fake timers here, and the click itself is all this test needs.
      fireEvent.click(screen.getByRole("button", { name: /reindex project/i }));
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

      // The post-enqueue refetch reported pending_jobs: 0 the whole time.
      await vi.waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(3));

      // …and it stops once the settle window is spent, rather than polling forever.
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = getIndexStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getIndexStatus).toHaveBeenCalledTimes(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the finished sweep even when it changed nothing", async () => {
    vi.useFakeTimers();
    try {
      // 19 nodes already indexed: re-embedding upserts in place, so the chunk
      // count is identical before and after. The sweep still happened.
      getIndexStatus.mockResolvedValue({
        ...IDLE,
        indexed_chunks: 21,
        indexable_nodes: 19,
        embed_model: "gemini-embedding-001",
      });
      reindexProject.mockResolvedValue({ enqueued: 19 });

      render(<ReindexPanel projectId="p1" />);
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: /reindex project/i })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: /reindex project/i }));
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

      // Nothing is claimed until the settle window is spent — a completion
      // line printed while jobs could still be queued would be a guess.
      await vi.waitFor(() => expect(getIndexStatus).toHaveBeenCalledTimes(2));
      expect(screen.queryByText(/reindex finished/i)).not.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(10_000);
      const done = await vi.waitFor(() => screen.getByText(/reindex finished/i));
      expect(done).toHaveTextContent("19 items re-embedded");
      expect(done).toHaveTextContent("21 chunks (unchanged)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not claim success when the server reported a dropped job", async () => {
    vi.useFakeTimers();
    try {
      getIndexStatus.mockResolvedValue({
        ...IDLE,
        indexable_nodes: 19,
        last_error: {
          code: "no_model_connection",
          message: "No embedding model resolved for this workspace.",
          node_type: "requirements",
          node_id: "r1",
          at: "2026-08-09T12:00:00Z",
        },
      });
      reindexProject.mockResolvedValue({ enqueued: 19 });

      render(<ReindexPanel projectId="p1" />);
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: /reindex project/i })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: /reindex project/i }));
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(screen.getByText(/no_model_connection/)).toBeInTheDocument();
      expect(screen.queryByText(/reindex finished/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("timestamps each check so an unchanged count still shows the panel looked", async () => {
    getIndexStatus.mockResolvedValue({ ...IDLE, indexed_chunks: 21, indexable_nodes: 19 });

    render(<ReindexPanel projectId="p1" />);
    expect(await screen.findByText(/checked /i)).toBeInTheDocument();
  });

  it("explains a dropped job instead of leaving a frozen count unexplained", async () => {
    getIndexStatus.mockResolvedValue({
      ...IDLE,
      indexable_nodes: 59,
      last_error: {
        code: "no_model_connection",
        message: "No embedding model resolved for this workspace — jobs were discarded.",
        node_type: "requirements",
        node_id: "r1",
        at: "2026-08-09T12:00:00Z",
      },
    });

    render(<ReindexPanel projectId="p1" />);
    expect(await screen.findByText(/no_model_connection/)).toBeInTheDocument();
    expect(screen.getByText(/jobs were discarded/i)).toBeInTheDocument();
  });
});
