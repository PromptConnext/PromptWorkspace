import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBoardShortcuts } from "./useBoardShortcuts";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function setup(enabled = true) {
  const handlers = { onSearch: vi.fn(), onToggleMine: vi.fn() };
  const view = renderHook(
    (props: { enabled: boolean }) => useBoardShortcuts({ ...handlers, enabled: props.enabled }),
    { initialProps: { enabled } },
  );
  return { ...handlers, view };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useBoardShortcuts", () => {
  it("fires / and m", () => {
    const { onSearch, onToggleMine } = setup();
    const slash = press("/");
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(slash.defaultPrevented).toBe(true);
    press("m");
    expect(onToggleMine).toHaveBeenCalledTimes(1);
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  it("ignores keys typed into an input or textarea", () => {
    const { onSearch, onToggleMine } = setup();
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    document.body.append(input, area);
    input.focus();
    press("/", {}, input);
    press("m", {}, input);
    press("m", {}, area);
    expect(onSearch).not.toHaveBeenCalled();
    expect(onToggleMine).not.toHaveBeenCalled();
  });

  it("ignores modified presses and events already handled", () => {
    const { onToggleMine } = setup();
    press("m", { metaKey: true });
    press("m", { ctrlKey: true });
    const handled = new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(onToggleMine).not.toHaveBeenCalled();
  });

  it("stands down while a Radix popover is open", () => {
    const { onToggleMine } = setup();
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.append(popper);
    press("m");
    expect(onToggleMine).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", () => {
    const { onSearch, view } = setup(false);
    press("/");
    expect(onSearch).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    press("/");
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});
