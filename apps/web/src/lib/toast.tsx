"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Transient notifications, kept deliberately small and dependency-free.
 *
 * The board writes optimistically: a card changes the moment you drop it or
 * pick an assignee, and no refetch follows. That trade only holds if a failed
 * write is impossible to miss — the card silently snapping back to its old
 * value would read as "the app ate my edit". So every rollback raises a toast
 * carrying the server's own `detail` (`assignment_forbidden`, `status_forbidden`,
 * …) plus a Retry, which is the whole reason this module exists.
 *
 * Dismissal is deferred one frame past the exit transition rather than being
 * instant, so a toast leaving does not make the stack jump under the pointer of
 * someone reaching for its Retry button. For the same reason the countdown
 * pauses while a toast is hovered or holds focus, and resumes with whatever
 * time it had left.
 */

export type ToastVariant = "error" | "success" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed by hand. */
  duration?: number;
}

interface ToastRecord extends ToastInput {
  id: number;
  leaving: boolean;
}

/** A running toast's countdown, held while the pointer or focus is on it. */
interface Countdown {
  remaining: number;
  startedAt: number;
  hovered: boolean;
  focused: boolean;
}

// A toast let go of with a moment left still gets long enough to be read.
const MIN_RESUME = 1000;

interface ToastApi {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// Errors sit long enough to read a reason and reach for Retry; confirmations
// are acknowledgements, not reading material.
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  error: 8000,
  success: 3000,
  info: 4000,
};

const VARIANT_STYLE: Record<ToastVariant, string> = {
  error: "border-red-200 bg-white",
  success: "border-emerald-200 bg-white",
  info: "border-slate-200 bg-white",
};

const ACCENT_STYLE: Record<ToastVariant, string> = {
  error: "bg-red-500",
  success: "bg-emerald-500",
  info: "bg-slate-400",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  // Cleared on unmount so a timer cannot fire into a torn-down tree.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const countdowns = useRef(new Map<number, Countdown>());

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      const timer = timers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
      countdowns.current.delete(id);
      setToasts((current) => current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      const exit = setTimeout(() => remove(id), 150);
      timers.current.set(-id, exit);
    },
    [remove],
  );

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const variant = input.variant ?? "info";
      setToasts((current) => [...current, { ...input, variant, id, leaving: false }]);
      const duration = input.duration ?? DEFAULT_DURATION[variant];
      if (duration > 0) {
        countdowns.current.set(id, {
          remaining: duration,
          startedAt: Date.now(),
          hovered: false,
          focused: false,
        });
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const hold = useCallback(
    (id: number, reason: "hovered" | "focused", on: boolean) => {
      const c = countdowns.current.get(id);
      if (!c) return;
      const wasHeld = c.hovered || c.focused;
      c[reason] = on;
      const held = c.hovered || c.focused;
      if (held && !wasHeld) {
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
        c.remaining -= Date.now() - c.startedAt;
      } else if (!held && wasHeld) {
        c.startedAt = Date.now();
        c.remaining = Math.max(c.remaining, MIN_RESUME);
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), c.remaining),
        );
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // `polite` rather than `assertive`: a failed save is worth announcing but
        // not worth cutting off whatever the screen reader is mid-sentence on.
        // The live region is the container, not each toast — nesting a `status`
        // inside it would announce every message twice.
        aria-live="polite"
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onMouseEnter={() => hold(t.id, "hovered", true)}
            onMouseLeave={() => hold(t.id, "hovered", false)}
            onFocus={() => hold(t.id, "focused", true)}
            onBlur={(e) => {
              // Focus moving between the toast's own buttons is still focus.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                hold(t.id, "focused", false);
              }
            }}
            className={[
              "pointer-events-auto flex gap-3 overflow-hidden rounded-lg border shadow-lg transition-all duration-150",
              VARIANT_STYLE[t.variant ?? "info"],
              t.leaving ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100",
            ].join(" ")}
          >
            <span className={`w-1 shrink-0 ${ACCENT_STYLE[t.variant ?? "info"]}`} aria-hidden />
            <div className="flex-1 py-2.5 pr-2">
              <p className="text-sm font-medium text-slate-900">{t.title}</p>
              {t.description && <p className="mt-0.5 text-xs text-slate-500">{t.description}</p>}
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(t.id);
                    t.action?.onClick();
                  }}
                  className="mt-1.5 rounded text-xs font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="px-2 text-slate-400 transition-colors hover:text-slate-600"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Returns a no-op outside a provider instead of throwing. A toast is feedback,
 * never the mechanism — a component rendered in a test harness (or any tree
 * that has not mounted the provider) should still do its actual job.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return ctx ?? NOOP_TOAST;
}

const NOOP_TOAST: ToastApi = { toast: () => 0, dismiss: () => {} };
