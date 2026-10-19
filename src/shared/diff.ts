// Line diff of two texts: the counts shown when the YAML of an object is applied.
// Pure module, unit tested.

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

/** Beyond this many cells (changed lines before × after), the changed block is shown as removed then added. */
const MAX_TABLE = 4_000_000;

/** Longest common subsequence diff, after trimming the common start and end (an edit is usually small). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const head = a.slice(0, start).map((text): DiffLine => ({ op: " ", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ op: " ", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const removed = a.map((text): DiffLine => ({ op: "-", text }));
  const added = b.map((text): DiffLine => ({ op: "+", text }));
  if (!a.length || !b.length || a.length * b.length > MAX_TABLE) return [...removed, ...added];
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i++] });
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] });
  while (j < b.length) out.push({ op: "+", text: b[j++] });
  return out;
}

/** Numbers of removed and added lines. */
export function diffStats(before: string, after: string): { removed: number; added: number } {
  const lines = lineDiff(before, after);
  return { removed: lines.filter((l) => l.op === "-").length, added: lines.filter((l) => l.op === "+").length };
}
