// Next.js server instrumentation hook (plan 0021 M2). Runs once per server
// runtime before anything else, which is where Sentry has to be initialised.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Next.js hands every uncaught server-side request error here. Scrubbing is
// the same `beforeSend` every other path goes through (src/lib/sentry.ts) —
// this only decides *what* is captured, never what a report may contain.
export const onRequestError = Sentry.captureRequestError;
