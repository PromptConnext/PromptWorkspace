"use client";

import { useEffect } from "react";

// Next.js App Router route-segment error boundary (WP3). Catches render
// errors thrown by children of the root layout and shows a recoverable
// fallback instead of crashing the whole page.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "[web] uncaught render error",
        error: error.message,
        digest: error.digest,
        stack: error.stack,
      }),
    );
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <p className="text-slate-900">Something went wrong.</p>
      <button
        onClick={reset}
        className="rounded bg-slate-900 px-4 py-2 text-white"
      >
        Try again
      </button>
    </div>
  );
}
