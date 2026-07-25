"use client";

import { useEffect } from "react";

// Next.js App Router root-layout error boundary (WP3). Only fires when the
// root layout itself throws, in which case it must render its own
// <html>/<body> since it replaces the layout it's reporting on.
export default function GlobalError({
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
        msg: "[web] uncaught root layout error",
        error: error.message,
        digest: error.digest,
        stack: error.stack,
      }),
    );
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-4">
          <p>Something went wrong.</p>
          <button
            onClick={reset}
            className="rounded bg-slate-900 px-4 py-2 text-white"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
