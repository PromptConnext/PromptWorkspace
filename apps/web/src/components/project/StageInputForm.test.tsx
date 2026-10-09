import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, StageInputForm } from "./StageInputForm";
import {
  CONSTITUTION_FIELDS,
  stageDraftKey,
  type StageAnswers,
  type StageField,
} from "./stage-forms";

vi.mock("@/lib/auth", () => {
  const auth = { authHeaders: () => ({ Authorization: "Bearer test" }) };
  return { useAuth: () => auth };
});

const getStageInputs = vi.fn();
const putStageInputs = vi.fn();
const prefillStage = vi.fn();
vi.mock("@/lib/api", () => ({
  getStageInputs: (...args: unknown[]) => getStageInputs(...args),
  putStageInputs: (...args: unknown[]) => putStageInputs(...args),
  prefillStage: (...args: unknown[]) => prefillStage(...args),
}));

const FIELDS: StageField[] = [
  { key: "problem", label: "Problem", type: "textarea", required: true },
  { key: "users", label: "Users", type: "text" },
];

const DRAFT_KEY = stageDraftKey("p1", "specify");
const UNSAVED_KEY = `${DRAFT_KEY}:unsaved`;

function serverHas(inputs: Record<string, string>) {
  getStageInputs.mockResolvedValue({ stage: "specify", inputs, updated_at: null, updated_by: null });
}

let flush: { current: (() => void) | null } | null = null;

function Harness({
  withPrefill = false,
  fields = FIELDS,
}: {
  withPrefill?: boolean;
  fields?: StageField[];
}) {
  const [answers, setAnswers] = useState<StageAnswers>({});
  const flushRef = useRef<(() => void) | null>(null);
  flush = flushRef;
  return (
    <StageInputForm
      projectId="p1"
      stage="specify"
      fields={fields}
      answers={answers}
      onChange={setAnswers}
      flushRef={flushRef}
      prefill={
        withPrefill
          ? { label: "Suggest from Spec", busyLabel: "…", ariaLabel: "Suggest", description: "" }
          : undefined
      }
    />
  );
}

// Lets the GET resolve and React commit what it caused.
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const problem = () => screen.getByLabelText(/Problem/) as HTMLTextAreaElement;

describe("StageInputForm — answers stored in the cloud", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    getStageInputs.mockReset();
    putStageInputs.mockReset();
    prefillStage.mockReset();
    putStageInputs.mockImplementation(async (_p, stage, inputs) => ({
      stage,
      inputs,
      updated_at: "2026-10-03T00:00:00Z",
      updated_by: "u1",
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("restores the server's answers on mount, over a local draft", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "old local" }));
    serverHas({ problem: "Riders wait too long", users: "Commuters" });

    render(<Harness />);
    await settle();

    expect(getStageInputs).toHaveBeenCalledWith("p1", "specify", { Authorization: "Bearer test" });
    expect(problem().value).toBe("Riders wait too long");
    expect((screen.getByLabelText(/Users/) as HTMLInputElement).value).toBe("Commuters");
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(putStageInputs).not.toHaveBeenCalled();
  });

  it("shows the local draft while the server is loading, and when it has nothing", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "draft text" }));
    let resolve: (v: unknown) => void = () => {};
    getStageInputs.mockReturnValue(new Promise((r) => (resolve = r)));

    render(<Harness />);
    expect(problem().value).toBe("draft text");

    await act(async () => {
      resolve({ stage: "specify", inputs: {}, updated_at: null, updated_by: null });
    });
    await settle();
    expect(problem().value).toBe("draft text");
  });

  it("uploads a draft the server has never seen", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "draft text" }));
    serverHas({});

    render(<Harness />);
    await settle();
    await advance(AUTOSAVE_DELAY_MS);

    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0][2]).toEqual({ problem: "draft text" });
  });

  it("keeps local edits the server never acknowledged, then saves them", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "unsaved edit" }));
    localStorage.setItem(UNSAVED_KEY, "1");
    serverHas({ problem: "older server copy" });

    render(<Harness />);
    await settle();
    expect(problem().value).toBe("unsaved edit");

    await advance(AUTOSAVE_DELAY_MS);
    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0][2]).toEqual({ problem: "unsaved edit" });
    expect(localStorage.getItem(UNSAVED_KEY)).toBeNull();
  });

  it("falls back to the local draft when the cloud can't be reached", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "draft text" }));
    getStageInputs.mockRejectedValue(new Error("network down"));

    render(<Harness />);
    await settle();
    expect(problem().value).toBe("draft text");

    // Editing is allowed, but nothing is written over server answers that
    // were never read — the edit waits on this device.
    fireEvent.change(problem(), { target: { value: "edited offline" } });
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(putStageInputs).not.toHaveBeenCalled();
    expect(localStorage.getItem(UNSAVED_KEY)).toBe("1");
    await act(async () => {
      flush?.current?.();
    });
    expect(putStageInputs).not.toHaveBeenCalled();
  });

  it("retries the read after a failure and only then saves", async () => {
    getStageInputs.mockRejectedValue(new Error("network down"));
    render(<Harness />);
    await settle();
    fireEvent.change(problem(), { target: { value: "edited offline" } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(putStageInputs).not.toHaveBeenCalled();

    serverHas({ problem: "server copy" });
    await advance(60_000);
    expect(getStageInputs.mock.calls.length).toBeGreaterThan(1);
    await advance(AUTOSAVE_DELAY_MS);
    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0][2]).toEqual({ problem: "edited offline" });
  });

  it("is read-only until the server's answers arrive, and never writes first", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "stale local" }));
    let resolve: (v: unknown) => void = () => {};
    getStageInputs.mockReturnValue(new Promise((r) => (resolve = r)));

    render(<Harness />);
    expect(problem()).toBeDisabled();
    expect(screen.getByText("Loading saved answers…")).toBeInTheDocument();

    fireEvent.change(problem(), { target: { value: "typed early" } });
    await act(async () => {
      flush?.current?.();
    });
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(putStageInputs).not.toHaveBeenCalled();

    await act(async () => {
      resolve({ stage: "specify", inputs: { problem: "server copy" }, updated_at: null, updated_by: null });
    });
    await settle();
    expect(problem()).not.toBeDisabled();
    expect(problem().value).toBe("server copy");
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(putStageInputs).not.toHaveBeenCalled();
  });

  it("never uploads or caches a draft that is only the field defaults", async () => {
    const withDefault: StageField[] = [
      { key: "problem", label: "Problem", type: "textarea", defaultValue: "Default text" },
    ];
    serverHas({});
    render(<Harness fields={withDefault} />);
    await settle();
    expect(problem().value).toBe("Default text");
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(putStageInputs).not.toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    cleanup();

    // A defaults-only draft cached by an earlier build is not an edit either.
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ problem: "Default text" }));
    render(<Harness fields={withDefault} />);
    await settle();
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(putStageInputs).not.toHaveBeenCalled();
  });

  it("typing in an optional rules field does not append to default text", async () => {
    serverHas({});
    render(<Harness fields={CONSTITUTION_FIELDS} />);
    await settle();

    const quality = screen.getByLabelText(/Quality bar/) as HTMLTextAreaElement;
    // The standard text is a hint to read, not a value to edit around.
    expect(quality.value).toBe("");
    expect(quality.placeholder).toContain("Tests, linting, and type checks pass in CI");

    fireEvent.change(quality, { target: { value: "100% coverage" } });
    expect(quality.value).toBe("100% coverage");
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(putStageInputs.mock.calls[0][2]).toMatchObject({ quality: "100% coverage" });
    expect(putStageInputs.mock.calls[0][2].quality).not.toContain("Tests, linting");
  });

  it("shows governance as a multi-line field so its standard text is not clipped", async () => {
    serverHas({});
    render(<Harness fields={CONSTITUTION_FIELDS} />);
    await settle();

    const governance = screen.getByLabelText(/Governance/);
    expect(governance.tagName).toBe("TEXTAREA");
    expect((governance as HTMLTextAreaElement).value).toBe("");
    expect((governance as HTMLTextAreaElement).placeholder).toContain("Tech Lead approval");
  });

  it("sends the pending save, with the latest answers, when unmounted", async () => {
    serverHas({});
    const { unmount } = render(<Harness />);
    await settle();
    fireEvent.change(problem(), { target: { value: "R" } });
    fireEvent.change(problem(), { target: { value: "Riders" } });
    unmount();
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0][2]).toEqual({ problem: "Riders" });
  });

  it("serializes overlapping saves so the server ends on the latest answers", async () => {
    serverHas({});
    let server: StageAnswers | null = null;
    const finishers: Array<() => void> = [];
    putStageInputs.mockImplementation(
      (_p, stage, inputs) =>
        new Promise((r) =>
          finishers.push(() => {
            server = inputs;
            r({ stage, inputs, updated_at: null, updated_by: "u1" });
          }),
        ),
    );
    render(<Harness />);
    await settle();

    fireEvent.change(problem(), { target: { value: "first" } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(putStageInputs).toHaveBeenCalledTimes(1);

    fireEvent.change(problem(), { target: { value: "second" } });
    await advance(AUTOSAVE_DELAY_MS);
    // The second waits for the first rather than racing it.
    expect(putStageInputs).toHaveBeenCalledTimes(1);

    await act(async () => finishers[0]());
    await settle();
    expect(putStageInputs).toHaveBeenCalledTimes(2);
    expect(putStageInputs.mock.calls[1][2]).toEqual({ problem: "second" });
    await act(async () => finishers[1]());
    expect(server).toEqual({ problem: "second" });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(localStorage.getItem(UNSAVED_KEY)).toBeNull();
  });

  it("does not write anything just for opening the form", async () => {
    serverHas({});
    render(<Harness />);
    await settle();
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(putStageInputs).not.toHaveBeenCalled();
  });

  it("autosaves once typing pauses, with the latest answers", async () => {
    serverHas({});
    render(<Harness />);
    await settle();

    fireEvent.change(problem(), { target: { value: "R" } });
    await advance(AUTOSAVE_DELAY_MS / 2);
    fireEvent.change(problem(), { target: { value: "Riders" } });
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(putStageInputs).not.toHaveBeenCalled();
    expect(localStorage.getItem(UNSAVED_KEY)).toBe("1");

    await advance(1);
    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0].slice(0, 3)).toEqual([
      "p1",
      "specify",
      { problem: "Riders" },
    ]);
    expect(localStorage.getItem(UNSAVED_KEY)).toBeNull();
  });

  it("says Saving… then Saved, in a polite live region", async () => {
    serverHas({});
    let finish: (v: unknown) => void = () => {};
    putStageInputs.mockReturnValue(new Promise((r) => (finish = r)));
    render(<Harness />);
    await settle();

    fireEvent.change(problem(), { target: { value: "x" } });
    await advance(AUTOSAVE_DELAY_MS);
    const status = screen.getByText("Saving…");
    expect(status.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");

    await act(async () => {
      finish({ stage: "specify", inputs: { problem: "x" }, updated_at: null, updated_by: "u1" });
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("says when a save failed and retries on request", async () => {
    serverHas({});
    putStageInputs.mockRejectedValueOnce(new Error("cloud HTTP 500"));
    render(<Harness />);
    await settle();

    fireEvent.change(problem(), { target: { value: "x" } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(screen.getByText(/Couldn.t save/)).toBeInTheDocument();
    expect(localStorage.getItem(UNSAVED_KEY)).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await settle();
    expect(putStageInputs).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(localStorage.getItem(UNSAVED_KEY)).toBeNull();
  });

  it("keeps answers on this device, without a retry, while the server can't store them", async () => {
    serverHas({});
    putStageInputs.mockRejectedValue(
      Object.assign(new Error("stage_inputs_unavailable"), { status: 503 }),
    );
    render(<Harness />);
    await settle();

    fireEvent.change(problem(), { target: { value: "x" } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(screen.getByText("Saved on this device")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t save/)).toBeNull();
    expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
    expect(localStorage.getItem(UNSAVED_KEY)).toBe("1");
  });

  it("saves immediately when flushed (Generate), without waiting for the debounce", async () => {
    serverHas({});
    render(<Harness />);
    await settle();

    fireEvent.change(problem(), { target: { value: "now" } });
    await act(async () => {
      flush?.current?.();
    });
    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0][2]).toEqual({ problem: "now" });

    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(putStageInputs).toHaveBeenCalledTimes(1);
  });

  it("saves the fields a prefill suggestion filled in", async () => {
    serverHas({});
    prefillStage.mockResolvedValue({
      fields: { problem: "Drafted problem", users: "Drafted users" },
      sources: ["spec"],
    });
    render(<Harness withPrefill />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
    await settle();
    expect(problem().value).toBe("Drafted problem");

    await advance(AUTOSAVE_DELAY_MS);
    expect(putStageInputs).toHaveBeenCalledTimes(1);
    expect(putStageInputs.mock.calls[0][2]).toEqual({
      problem: "Drafted problem",
      users: "Drafted users",
    });
  });
});
