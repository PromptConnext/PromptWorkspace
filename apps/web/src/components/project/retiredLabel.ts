// How many references the Planner names before it falls back to a count.
const MAX_NAMED_REFS = 5;

/** "2 retired (T003, T004)" — the tasks a regeneration or save tombstoned, by
 *  reference. Names at most five, then "and N more"; with no refs (an older
 *  server, or a row with nothing to name) it is just "2 retired". */
export function retiredLabel(count: number, refs?: string[] | null): string {
  if (!refs || refs.length === 0) return `${count} retired`;
  const named = refs.slice(0, MAX_NAMED_REFS).join(", ");
  const more = refs.length - MAX_NAMED_REFS;
  return more > 0 ? `${count} retired (${named}, and ${more} more)` : `${count} retired (${named})`;
}
