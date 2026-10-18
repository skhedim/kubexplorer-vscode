import { describe, expect, it } from "vitest";
import { evalJsonPath } from "../../../src/resources/crd";
import { formatAge, formatBytes } from "../../../src/resources/format";

describe("formatAge", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  it.each([
    ["2026-10-18T11:59:15Z", "45s"],
    ["2026-10-18T11:48:00Z", "12m"],
    ["2026-10-18T08:48:00Z", "3h12m"],
    ["2026-10-14T06:00:00Z", "4d6h"],
    ["2026-09-07T12:00:00Z", "41d"],
  ])("%s is %s old", (iso, expected) => expect(formatAge(iso, now)).toBe(expected));
});

describe("formatBytes", () => {
  it("formats memory quantities", () => {
    expect(formatBytes("16303384Ki")).toBe("15.5 GiB");
    expect(formatBytes("512Mi")).toBe("512 MiB");
  });
});

describe("evalJsonPath", () => {
  it("evaluates printer column paths", () => {
    expect(evalJsonPath({ status: { conditions: [{ type: "Ready" }] } }, ".status.conditions[0].type")).toBe("Ready");
    expect(evalJsonPath({ spec: {} }, ".spec.missing.deep")).toBeUndefined();
  });
});
