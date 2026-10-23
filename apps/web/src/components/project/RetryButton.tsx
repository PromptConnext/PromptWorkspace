"use client";

/** The Retry beside a failed load's error line. */
export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:border-slate-300"
    >
      Retry
    </button>
  );
}
