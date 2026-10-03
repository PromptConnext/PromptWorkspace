"use client";

import { useEffect, useRef } from "react";

/**
 * Single-key board shortcuts: `/` focuses search, `m` toggles My Tasks. Esc
 * is not one of them: the search box clears itself and the drawer closes
 * itself, and a board-level Esc on top of either would act twice on one press.
 *
 * Bare letters are only safe when nobody is typing, so the hook stands down
 * whenever focus is in a text field, a modifier is held (Cmd+M minimises a
 * window; that press is not ours), or a Radix popover — a Select's listbox —
 * is open and owns the keyboard.
 *
 * It listens on `window` in the bubble phase, the last stop for a key event,
 * and skips anything already marked handled.
 */
export function useBoardShortcuts({
  onSearch,
  onToggleMine,
  enabled = true,
}: {
  onSearch: () => void;
  onToggleMine: () => void;
  enabled?: boolean;
}): void {
  // Callers pass inline arrows; reading them through a ref keeps one listener
  // for the life of the board instead of re-binding on every render.
  const handlers = useRef({ onSearch, onToggleMine });
  useEffect(() => {
    handlers.current = { onSearch, onToggleMine };
  });

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
      if (popoverOpen()) return;

      // A modal dialog (the task drawer) is on top; reaching through it to
      // the board's search or filters would act on something you can't see.
      if (document.activeElement?.closest('[aria-modal="true"]')) return;

      if (event.key === "/") {
        // Without this the "/" lands in the search box we just focused.
        event.preventDefault();
        handlers.current.onSearch();
      } else if (event.key === "m" && !event.shiftKey) {
        event.preventDefault();
        handlers.current.onToggleMine();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("[contenteditable='true'], [contenteditable='']")) {
    return true;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  const role = target.getAttribute("role");
  return role === "combobox" || role === "listbox" || role === "option" || role === "textbox";
}

function popoverOpen(): boolean {
  return document.querySelector("[data-radix-popper-content-wrapper]") !== null;
}
