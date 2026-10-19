// Line diff of the YAML of an object, before it is applied.
import { describe, expect, it } from "vitest";
import { diffStats, lineDiff } from "../../../src/shared/diff";

const yaml = (replicas: number, image: string) =>
  ["apiVersion: apps/v1", "kind: Deployment", "spec:", `  replicas: ${replicas}`, "  template:", `    image: ${image}`, ""].join("\n");

describe("lineDiff", () => {
  it("keeps the unchanged lines and pairs the changed ones", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "x" },
      { op: " ", text: "c" },
    ]);
  });

  it("finds insertions and deletions in the middle", () => {
    const ops = lineDiff("a\nb\nc\nd", "a\nc\nd\ne").map((l) => `${l.op}${l.text}`);
    expect(ops).toEqual([" a", "-b", " c", " d", "+e"]);
  });

  it("returns only unchanged lines for equal texts", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.op === " ")).toBe(true);
  });
});

describe("diffStats", () => {
  it("counts the removed and added lines", () => {
    expect(diffStats(yaml(2, "nginx:1.27"), yaml(3, "nginx:1.29"))).toEqual({ removed: 2, added: 2 });
    expect(diffStats("a\nb", "a\nb\nc\nd")).toEqual({ removed: 0, added: 2 });
  });

  it("stays fast on large documents with a small edit", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[10_000] = "changed";
    const started = Date.now();
    expect(diffStats(lines.join("\n"), changed.join("\n"))).toEqual({ removed: 1, added: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("falls back to a block replacement beyond its table size", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(diffStats(a, b)).toEqual({ removed: 3000, added: 3000 });
  });
});
