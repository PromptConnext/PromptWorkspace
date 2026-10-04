import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudGet } from "@/lib/hooks";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// Stable references: the hook's effects key on `user`, so a fresh object per
// render would refetch forever.
const auth = { user: { id: "u1" }, authHeaders: () => ({}) };
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  setVisibility("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCloudGet", () => {
  it("mutate replaces the data locally without a request", async () => {
    apiFetch.mockResolvedValueOnce({ n: 1 });
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    act(() => result.current.mutate({ n: 2 }));

    expect(result.current.data).toEqual({ n: 2 });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("a background response that started before mutate does not overwrite it", async () => {
    apiFetch.mockResolvedValueOnce({ n: 1 });
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    let resolve!: (v: { n: number }) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    act(() => result.current.revalidate());
    act(() => result.current.mutate({ n: 3 }));
    expect(result.current.refreshing).toBe(false);
    await act(async () => resolve({ n: 2 }));

    expect(result.current.data).toEqual({ n: 3 });
    // And background refreshes still work afterwards.
    apiFetch.mockResolvedValueOnce({ n: 4 });
    act(() => result.current.revalidate());
    await waitFor(() => expect(result.current.data).toEqual({ n: 4 }));
  });

  it("a first load that started before mutate does not overwrite it", async () => {
    let resolve!: (v: { n: number }) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));

    act(() => result.current.mutate({ n: 3 }));
    await act(async () => resolve({ n: 1 }));

    expect(result.current.data).toEqual({ n: 3 });
    expect(result.current.loading).toBe(false);
  });

  it("sets loading on the first load and clears it with data", async () => {
    apiFetch.mockResolvedValue({ n: 1 });
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.lastUpdated).not.toBeNull();
  });

  it("revalidate keeps data, never flips loading, and updates in place", async () => {
    apiFetch.mockResolvedValueOnce({ n: 1 });
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    let resolve!: (v: { n: number }) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    act(() => result.current.revalidate());
    expect(result.current.refreshing).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ n: 1 });

    await act(async () => resolve({ n: 2 }));
    expect(result.current.refreshing).toBe(false);
    expect(result.current.data).toEqual({ n: 2 });
  });

  it("a failed revalidate keeps data and reports refreshError, not error", async () => {
    apiFetch.mockResolvedValueOnce({ n: 1 });
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    apiFetch.mockRejectedValueOnce(new Error("boom"));
    act(() => result.current.revalidate());
    await waitFor(() => expect(result.current.refreshError).toBe("boom"));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ n: 1 });
  });

  it("does not overlap background requests", async () => {
    apiFetch.mockResolvedValueOnce({ n: 1 });
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    apiFetch.mockReturnValue(new Promise(() => {}));
    act(() => result.current.revalidate());
    act(() => result.current.revalidate());
    expect(apiFetch).toHaveBeenCalledTimes(2); // initial + one background
  });

  it("clears a first-load error once a background refresh succeeds", async () => {
    apiFetch.mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    await waitFor(() => expect(result.current.error).toBe("down"));

    apiFetch.mockResolvedValueOnce({ n: 2 });
    act(() => result.current.revalidate());
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(result.current.error).toBeNull();
  });

  it("does not start a background request while the first load is out", async () => {
    let resolve!: (v: { n: number }) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useCloudGet<{ n: number }>("/x"));
    expect(result.current.loading).toBe(true);

    act(() => result.current.revalidate());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(false);

    await act(async () => resolve({ n: 1 }));
    expect(result.current.data).toEqual({ n: 1 });
    apiFetch.mockResolvedValueOnce({ n: 2 });
    act(() => result.current.revalidate());
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("polls while visible and pauses while hidden", async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue({ n: 1 });
    renderHook(() => useCloudGet<{ n: number }>("/x", true, { pollMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue({ n: 1 });
    const { unmount } = renderHook(() => useCloudGet<{ n: number }>("/x", true, { pollMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes on window focus when refreshOnFocus is set", async () => {
    apiFetch.mockResolvedValue({ n: 1 });
    const { result } = renderHook(() =>
      useCloudGet<{ n: number }>("/x", true, { refreshOnFocus: true }),
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
  });
});
