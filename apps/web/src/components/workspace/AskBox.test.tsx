import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskBox } from "./AskBox";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function mockStream(...frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(encoder.encode(f + "\n\n"));
      c.close();
    },
  });
  const fn = vi.fn().mockResolvedValue({ ok: true, body });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const FACTS = {
  my_open_decisions: [
    { project_id: "p1", project_name: "Alpha", kind: "plan_approval", expires_at: null },
    { project_id: "p2", project_name: "Beta", kind: "plan_approval", expires_at: null },
  ],
  projects_missing_hats: [
    { project_id: "p1", name: "Alpha", hats: ["tech_steward"] },
    { project_id: "p2", name: "Beta", hats: ["tech_steward"] },
  ],
  overdue: [],
  by_runtime: {},
  agent_closed_30d: 7,
};

describe("AskBox", () => {
  it("shows three example chips and submits the typed question", async () => {
    const fetchMock = mockStream("event: facts\ndata: " + JSON.stringify(FACTS), "event: done\ndata: {}");
    render(<AskBox workspaceId="w1" />);
    expect(screen.getByLabelText("Ask about this workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What is waiting on me?" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Which projects have no tech steward?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "What did agents close this month?" }),
    ).toBeInTheDocument();

    const input = screen.getByLabelText("Ask about this workspace");
    fireEvent.change(input, { target: { value: "who owns Alpha?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspaces/w1/ask");
    expect(JSON.parse(init.body)).toEqual({ question: "who owns Alpha?" });
  });

  it("renders facts as sentences when no delta arrives", async () => {
    mockStream("event: facts\ndata: " + JSON.stringify(FACTS), "event: done\ndata: {}");
    render(<AskBox workspaceId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "What is waiting on me?" }));
    expect(await screen.findByText("You have 2 decisions waiting.")).toBeInTheDocument();
    expect(screen.getByText("Projects with no tech steward: Alpha, Beta.")).toBeInTheDocument();
    expect(screen.getByText("No decisions are overdue.")).toBeInTheDocument();
    expect(
      screen.getByText("Agents closed 7 tasks in the last 30 days."),
    ).toBeInTheDocument();
  });

  it("streams deltas into the answer", async () => {
    mockStream(
      "event: facts\ndata: " + JSON.stringify(FACTS),
      'data: {"delta":"Two decisions "}',
      'data: {"delta":"are waiting."}',
      "event: done\ndata: {}",
    );
    render(<AskBox workspaceId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "What is waiting on me?" }));
    expect(await screen.findByText("Two decisions are waiting.")).toBeInTheDocument();
    expect(screen.queryByText("You have 2 decisions waiting.")).not.toBeInTheDocument();
  });
});
