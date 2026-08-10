/**
 * DOM APIs happy-dom doesn't implement that Radix's popper-backed primitives
 * (Select, and anything else built on the same floating layer) call
 * unconditionally while opening. A native <select> needed none of these — the
 * OS drew the list — so they only became a test dependency when the pickers
 * moved to Radix.
 *
 * Each is stubbed to the least-surprising no-op rather than emulated: the
 * component tests assert on which options exist and what selecting one does,
 * never on where the popover landed, so measurement fidelity buys nothing here.
 */

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  // Radix asks whether the trigger already holds the pointer before it starts a
  // drag-select; answering "no" is what keeps it on the plain click/keyboard path.
  Element.prototype.hasPointerCapture ??= function hasPointerCapture() {
    return false;
  };
  Element.prototype.setPointerCapture ??= function setPointerCapture() {};
  Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
}
