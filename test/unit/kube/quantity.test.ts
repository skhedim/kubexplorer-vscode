import { describe, expect, it } from "vitest";
import { cpuMillis, formatCpu, formatMemory, memoryBytes, parseQuantity } from "../../../src/kube/quantity";

describe("quantities", () => {
  it.each([
    ["21608n", 0.021608],
    ["250m", 250],
    ["2", 2000],
    ["1.5", 1500],
  ])("CPU %s is %s millicores", (q, millis) => expect(cpuMillis(q)).toBeCloseTo(millis));

  it.each([
    ["16308Ki", 16308 * 1024],
    ["512Mi", 512 * 2 ** 20],
    ["1G", 1e9],
    ["1e3", 1000],
  ])("memory %s is %s bytes", (q, bytes) => expect(memoryBytes(q)).toBe(bytes));

  it("returns NaN for unreadable quantities", () => {
    expect(parseQuantity("abc")).toBeNaN();
    expect(parseQuantity("12Xi")).toBeNaN();
    expect(parseQuantity(undefined)).toBeNaN();
  });

  it("formats like Freelens", () => {
    expect(formatCpu(0.02)).toBe("<1m");
    expect(formatCpu(0)).toBe("0");
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1500)).toBe("1.50");
    expect(formatMemory(16308 * 1024)).toBe("15.9Mi");
    expect(formatMemory(3 * 2 ** 30)).toBe("3.0Gi");
    expect(formatMemory(NaN)).toBe("");
  });
});
