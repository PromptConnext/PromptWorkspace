import type { GenerationWarning } from "@/lib/types";

/** Notices the cloud attached to a generation that still succeeded. Today: tasks
 *  for an imported repository that name a file which is neither in the repository
 *  nor marked `(new)` — usually a path the model invented for behaviour that
 *  exists under another name; and a task list whose numbering has gaps.
 *  Reported, never rewritten. */
export function GenerationWarnings({ warnings }: { warnings?: GenerationWarning[] }) {
  const unmarkedItems = warnings?.flatMap((w) => (w.code === "unmarked_new_paths" ? w.items : []));
  const missingItems = warnings?.flatMap((w) => (w.code === "missing_task_numbers" ? w.items : []));
  const hasUnmarked = !!unmarkedItems && unmarkedItems.length > 0;
  const hasMissing = !!missingItems && missingItems.length > 0;
  if (!hasUnmarked && !hasMissing) return null;
  return (
    <>
      {hasMissing && missingItems && (
        <div role="status" className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">
          Task numbers missing from the generated list: {missingItems.join(", ")}. Regenerate, or
          add them by hand.
        </div>
      )}
      {hasUnmarked && unmarkedItems && <UnmarkedPaths items={unmarkedItems} />}
    </>
  );
}

function UnmarkedPaths({ items }: { items: { ref: string; path: string }[] }) {
  const tasks = new Set(items.map((item) => item.ref)).size;
  return (
    <div role="status" className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">
        {tasks === 1
          ? "1 task names a file that isn't in the repository"
          : `${tasks} tasks name files that aren't in the repository`}
      </p>
      <p className="mt-1">
        Point each at the file that already holds the behaviour, or add <code>(new)</code> after
        the path if the task creates it, then save the tasks again.
      </p>
      <ul className="mt-2 space-y-0.5 text-xs">
        {items.map((item) => (
          <li key={`${item.ref}:${item.path}`}>
            <span className="font-mono">{item.ref}</span> · <code>{item.path}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
