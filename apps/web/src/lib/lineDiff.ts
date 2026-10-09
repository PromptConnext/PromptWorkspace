/** Past this many table cells (changed lines before x after) the LCS table is
 * skipped: it is 4 bytes a cell and quadratic time, and a document that
 * different is better shown as removed-then-added anyway. */
export const MAX_DIFF_CELLS = 4_000_000;

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** A line-based diff of two documents by longest common subsequence. Common
 * leading and trailing lines are peeled off first, so the quadratic table only
 * covers the part that changed. The output replays to both inputs: dropping
 * `add` lines gives `before`, dropping `del` lines gives `after`. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i] });

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_DIFF_CELLS) {
    for (let i = start; i < endA; i++) out.push({ kind: "del", text: a[i] });
    for (let j = start; j < endB; j++) out.push({ kind: "add", text: b[j] });
    for (let k = endA; k < a.length; k++) out.push({ kind: "same", text: a[k] });
    return out;
  }
  // lcs[i][j]: length of the LCS of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ kind: "same", text: a[start + i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ kind: "del", text: a[start + i++] });
    } else {
      out.push({ kind: "add", text: b[start + j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[start + i++] });
  while (j < m) out.push({ kind: "add", text: b[start + j++] });

  for (let k = endA; k < a.length; k++) out.push({ kind: "same", text: a[k] });
  return out;
}
