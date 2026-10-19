// Bounded concurrency: work on many clusters without starting as many processes at once.

/**
 * Runs `task` on every item, at most `limit` at a time, in order; once `cancelled()` returns true, no new task
 * starts. Tasks must handle their own errors.
 */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  cancelled: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !cancelled()) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
