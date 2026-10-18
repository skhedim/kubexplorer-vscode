import { describe, expect, it } from "vitest";
import { JsonStreamParser } from "../../../src/kube/jsonStream";

describe("JsonStreamParser", () => {
  it("splits compact or indented objects cut anywhere", () => {
    const out: unknown[] = [];
    const parser = new JsonStreamParser((v) => out.push(v));
    const text = '{"type":"ADDED","object":{"a":"}{"}}\n{\n  "type": "DELETED",\n  "object": {"b": [1, {"c": "\\"}"}]}\n}\n';
    for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7));
    expect(out).toEqual([
      { type: "ADDED", object: { a: "}{" } },
      { type: "DELETED", object: { b: [1, { c: '"}' }] } },
    ]);
  });

  it("ignores stray text between objects", () => {
    const out: unknown[] = [];
    const parser = new JsonStreamParser((v) => out.push(v));
    parser.push('Warning: something\n{"x":1}garbage{"y":2}');
    expect(out).toEqual([{ x: 1 }, { y: 2 }]);
  });
});
