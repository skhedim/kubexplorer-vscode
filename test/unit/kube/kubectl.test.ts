import { describe, expect, it } from "vitest";
import { cleanStderr, debugArgs, drainArgs, groupByKind, logArgs, nodeShellArgs } from "../../../src/kube/kubectl";

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

describe("groupByKind", () => {
  it("sorts the items of a combined list by requested kind, with the API group when Kinds collide", () => {
    const kinds = [
      { kubectlName: "nodes", namespaced: false, kindName: "Node" },
      { kubectlName: "kustomizations.kustomize.toolkit.fluxcd.io", namespaced: true, kindName: "Kustomization" },
      { kubectlName: "kustomizations.other.example.com", namespaced: true, kindName: "Kustomization" },
    ];
    const item = (kind: string, apiVersion: string, name: string) => ({ kind, apiVersion, metadata: { name, uid: name } });
    const out = groupByKind(
      [
        item("Node", "v1", "n1"),
        item("Kustomization", "kustomize.toolkit.fluxcd.io/v1", "apps"),
        item("Kustomization", "other.example.com/v1", "x"),
        item("Pod", "v1", "stray"),
      ],
      kinds,
    );
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.map((o) => o.metadata.name)]))).toEqual({
      nodes: ["n1"],
      "kustomizations.kustomize.toolkit.fluxcd.io": ["apps"],
      "kustomizations.other.example.com": ["x"],
    });
  });

  it("drains nodes like kubectl drain, keeping the DaemonSets", () => {
    expect(drainArgs("kind", ["n1", "n2"])).toEqual([
      "--context",
      "kind",
      "drain",
      "n1",
      "n2",
      "--ignore-daemonsets",
      "--delete-emptydir-data",
    ]);
  });

  it("opens a node shell in a privileged pod of the node, deleted on exit", () => {
    const args = nodeShellArgs("kind", "Kind-Worker.example", "busybox:1.37", "x1y2z");
    expect(args.slice(0, 9)).toEqual([
      "--context",
      "kind",
      "-n",
      "kube-system",
      "run",
      "node-shell-kind-worker-example-x1y2z",
      "--rm",
      "-it",
      "--restart=Never",
    ]);
    expect(args).toContain("--image=busybox:1.37");
    const overrides = JSON.parse(args.find((a) => a.startsWith("--overrides="))!.slice("--overrides=".length));
    expect(overrides.spec).toMatchObject({
      nodeName: "Kind-Worker.example",
      hostPID: true,
      hostNetwork: true,
      tolerations: [{ operator: "Exists" }],
    });
    const [container] = overrides.spec.containers;
    expect(container).toMatchObject({ name: "node-shell-kind-worker-example-x1y2z", securityContext: { privileged: true }, tty: true });
    expect(container.command.slice(0, 3)).toEqual(["nsenter", "--target", "1"]);
    // A pod name stays a valid DNS label, whatever the length of the node name.
    expect(nodeShellArgs("kind", "a".repeat(80), "busybox", "x1y2z")[5].length).toBeLessThanOrEqual(63);
  });
});
