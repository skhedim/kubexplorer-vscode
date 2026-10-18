import { describe, expect, it } from "vitest";
import { cleanStderr } from "../../../src/kube/kubectl";

describe("cleanStderr", () => {
  it("strips klog headers and duplicated lines", () => {
    const stderr = [
      "E1018 18:12:40.564748   24176 memcache.go:265] couldn't get current server API group list: connection refused",
      "E1018 18:12:40.566120   24176 memcache.go:265] couldn't get current server API group list: connection refused",
      "The connection to the server was refused",
    ].join("\n");
    expect(cleanStderr(stderr)).toBe(
      "couldn't get current server API group list: connection refused\nThe connection to the server was refused",
    );
  });

  it("keeps the last three distinct lines", () => {
    expect(cleanStderr("a\nb\nc\nd\n")).toBe("b\nc\nd");
  });
});
