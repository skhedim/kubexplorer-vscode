// Bounded concurrency.
import { describe, expect, it } from "vitest";
import { forEachLimited } from "../../../src/shared/pool";

describe("forEachLimited", () => {
  it("runs every task, never more than the limit at a time", async () => {
    let running = 0;
    let max = 0;
    const done: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, n % 3));
      running--;
      done.push(n);
    });
    expect(max).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("starts no new task once cancelled", async () => {
    const started: number[] = [];
    let cancel = false;
    await forEachLimited(
      [1, 2, 3, 4, 5],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) cancel = true;
      },
      () => cancel,
    );
    expect(started).toEqual([1, 2]);
  });

  it("handles no item", async () => {
    await expect(forEachLimited([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});
