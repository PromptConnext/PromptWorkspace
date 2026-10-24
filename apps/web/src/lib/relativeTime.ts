const UNITS: [number, string][] = [
  [365 * 24 * 3600, "year"],
  [30 * 24 * 3600, "month"],
  [24 * 3600, "day"],
  [3600, "hour"],
  [60, "minute"],
];

/** "2 hours ago". `now` is injectable so callers and tests stay deterministic. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 60) return "just now";
  for (const [size, name] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
