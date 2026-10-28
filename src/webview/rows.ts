// The rows of the main list: the full list sent by the extension, then its patches, sorted and filtered by the search
// box. The sorted rows are kept: a small patch moves its own rows, rather than sorting thousands of rows again.

import type { PersistedState } from "../shared/protocol";
import type { Row } from "../shared/view";

/**
 * Natural order ("pod-2" before "pod-10"), created once: localeCompare with options builds a collator at every call,
 * 20 times slower (190 ms instead of 10 ms to sort 5,000 rows).
 */
const collator = new Intl.Collator(undefined, { numeric: true });
/** A patch of more rows than this sorts the list again; a smaller one moves its rows only. */
const MAX_PATCH_INSERTS = 64;

export type Sort = NonNullable<PersistedState["sort"]>;

/**
 * The order of a sort, total: rows of equal value follow their name, then namespace, so that a row put in place by a
 * patch lands where a full sort would put it (and rows do not swap places as they change).
 */
function compareRows(sort: Sort): (a: Row, b: Row) => number {
  return (a, b) => {
    const va = a.sort[sort.col] ?? "";
    const vb = b.sort[sort.col] ?? "";
    const r = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
    if (r) return sort.desc ? -r : r;
    return (
      collator.compare(a.ref.name, b.ref.name) ||
      collator.compare(a.ref.namespace ?? "", b.ref.namespace ?? "") ||
      (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
    );
  };
}

/** Where `row` goes in `rows`, sorted by `compare` (binary search). */
function insertionIndex(rows: Row[], row: Row, compare: (a: Row, b: Row) => number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(rows[mid], row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ListRows {
  private rows: Row[] = [];
  /** The rows by uid, to apply patches. */
  private index = new Map<string, Row>();
  /** Bumped by every change of the rows: the sorted and visible rows are computed again only then. */
  private version = 0;
  /** Every row, sorted: kept up to date by the patches, sorted again only when needed. */
  private sorted?: { version: number; col: string; desc: boolean; rows: Row[] };
  private visibleCache?: { key: string; rows: Row[] };

  /** Every row, in the order the extension sent them. */
  get all(): readonly Row[] {
    return this.rows;
  }

  replace(rows: Row[]): void {
    this.rows = rows;
    this.index = new Map(rows.map((r) => [r.uid, r]));
    this.version++;
  }

  /** Applies the rows added or changed, and removed; `sort` is the current sort, to move the rows of the patch. */
  patch(upsert: Row[], remove: string[], sort: Sort | undefined): void {
    for (const uid of remove) this.index.delete(uid);
    for (const row of upsert) this.index.set(row.uid, row);
    this.rows = [...this.index.values()];
    this.version++;
    const s = this.sorted;
    if (!s || !sort || s.version !== this.version - 1 || s.col !== sort.col || s.desc !== sort.desc || upsert.length > MAX_PATCH_INSERTS) {
      this.sorted = undefined;
      return;
    }
    const gone = new Set([...remove, ...upsert.map((r) => r.uid)]);
    const rows = s.rows.filter((r) => !gone.has(r.uid));
    const compare = compareRows(sort);
    for (const row of upsert) rows.splice(insertionIndex(rows, row, compare), 0, row);
    this.sorted = { ...s, version: this.version, rows };
  }

  /** Every row, in the order of the sort. */
  private sortedRows(sort: Sort | undefined): Row[] {
    if (!sort) return this.rows;
    const s = this.sorted;
    if (s?.version === this.version && s.col === sort.col && s.desc === sort.desc) return s.rows;
    const rows = [...this.rows].sort(compareRows(sort));
    this.sorted = { version: this.version, ...sort, rows };
    return rows;
  }

  /** The rows matching the search, sorted; computed again only when the rows, the search or the sort change. */
  visible(search: string, sort: Sort | undefined): Row[] {
    const key = `${this.version}|${sort?.col}|${sort?.desc}|${search}`;
    if (this.visibleCache?.key === key) return this.visibleCache.rows;
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sorted = this.sortedRows(sort);
    const rows = terms.length ? sorted.filter((r) => terms.every((t) => r.search.includes(t))) : sorted;
    this.visibleCache = { key, rows };
    return rows;
  }
}
