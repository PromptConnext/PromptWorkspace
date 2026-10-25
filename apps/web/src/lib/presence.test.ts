import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({
  usePresenceAuthParam: () => ({ key: "token", value: "t" }),
}));

import { usePresence } from "./presence";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
}

describe("usePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never sends application heartbeats, and closes on unmount", () => {
    const { unmount } = renderHook(() => usePresence("p1"));
    const sock = FakeSocket.instances[0];
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(sock.send).not.toHaveBeenCalled();
    unmount();
    expect(sock.close).toHaveBeenCalled();
  });

  it("applies roster frames", () => {
    const { result } = renderHook(() => usePresence("p1"));
    act(() => {
      FakeSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "presence",
          users: [{ user_id: "u1", cursor_hint: null, last_seen: 1 }],
        }),
      });
    });
    expect(result.current).toHaveLength(1);
  });
});
