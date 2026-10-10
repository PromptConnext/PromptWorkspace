/** A thin bar showing `done` of `total`. Announced as a progress bar with the
 * counts as its value, so it says "2 of 3" to assistive technology rather than
 * being a purely visual strip. */
export function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  /** What the bar measures, e.g. "C1 Setup tasks done". */
  label: string;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total}`}
      className="h-2 rounded bg-slate-100"
    >
      <div className="h-2 rounded bg-slate-900" style={{ width: `${pct}%` }} />
    </div>
  );
}
