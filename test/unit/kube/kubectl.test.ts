import { describe, expect, it } from "vitest";
import { cleanStderr, debugArgs, logArgs } from "../../../src/kube/kubectl";

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

describe("kubectl arguments", () => {
  const base = { namespace: "shop", pod: "web-1", previous: false, follow: true, tailLines: 100 };

  it("follows the logs of every container of a pod, prefixed", () => {
    expect(logArgs("kind", base)).toEqual([
      ...["--context", "kind", "-n", "shop", "logs", "web-1", "--tail=100", "--timestamps"],
      ...["--all-containers", "--prefix", "-f"],
    ]);
    expect(logArgs("kind", { ...base, container: "app", previous: true })).toEqual([
      ...["--context", "kind", "-n", "shop", "logs", "web-1", "--tail=100", "--timestamps"],
      ...["-c", "app", "--previous"],
    ]);
  });

  it("follows the logs of the pods of a workload through its selector", () => {
    const args = logArgs("kind", { ...base, pod: "deployment/web", selector: "app=web,tier=front", container: "app" });
    expect(args).toEqual([
      ...["--context", "kind", "-n", "shop", "logs", "-l", "app=web,tier=front", "--prefix", "--max-log-requests=50"],
      ...["--tail=100", "--timestamps", "-c", "app", "-f"],
    ]);
    expect(args).not.toContain("deployment/web");
  });

  it("attaches an ephemeral debug container targeting a container", () => {
    expect(debugArgs("kind", "shop", "web-1", "app", "busybox:1.37")).toEqual([
      ...["--context", "kind", "-n", "shop", "debug", "web-1", "-it", "--image=busybox:1.37", "--target=app"],
    ]);
  });
});
