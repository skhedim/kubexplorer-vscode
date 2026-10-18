import { describe, expect, it } from "vitest";
import { DEMO_CONTEXT } from "../../../src/kube/demo";
import { PortForwardManager, suggestLocalPort } from "../../../src/kube/portForward";
import { nullLogger } from "../../../src/kube/types";

describe("port forwarding", () => {
  it.each([
    [80, 8080],
    [443, 8443],
    [53, 10053],
    [3000, 3000],
  ])("suggests local port %s for remote port %s", (remote, local) => expect(suggestLocalPort(remote)).toBe(local));

  it("refuses the demo cluster without spawning kubectl", async () => {
    const manager = new PortForwardManager(() => "kubectl-that-does-not-exist", nullLogger);
    await expect(manager.start(DEMO_CONTEXT, "default", "pods", "web", 80, 0)).rejects.toThrow(/demo cluster/);
    expect(manager.all()).toEqual([]);
  });
});
