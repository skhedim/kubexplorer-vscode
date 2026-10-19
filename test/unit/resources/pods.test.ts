import { describe, expect, it } from "vitest";
import { containerBricks, podRestarts, podStatus, podStatusTone, pods } from "../../../src/resources/pods";
import { byName, emptyDetailContext, fixture } from "../helpers";

const all = fixture("pods");

describe("pods (real kind cluster)", () => {
  it("detects a CrashLoopBackOff, with a warning", () => {
    const pod = byName(all, "fraud-scorer");
    expect(podStatus(pod)).toBe("CrashLoopBackOff");
    expect(podStatusTone(podStatus(pod))).toBe("error");
    expect(podRestarts(pod)).toBeGreaterThan(0);
    expect(containerBricks(pod).bricks.map((b) => b.state)).toEqual(["failed"]);
    expect(pods.toRow(pod).warning).toMatch(/not ready: scorer/);
  });

  it("flags an unschedulable pod", () => {
    const pod = byName(all, "ledger-worker");
    expect(podStatus(pod)).toBe("Pending");
    expect(pods.toRow(pod).warning).toMatch(/Unschedulable:.*Insufficient memory/);
    expect(pods.toRow(pod).cells.node).toBe("");
  });

  it("treats a completed Job pod as a success, without warning", () => {
    const pod = byName(all, "invoice-export");
    expect(podStatus(pod)).toBe("Succeeded");
    expect(podStatusTone("Succeeded")).toBe("success");
    expect(pods.toRow(pod).warning).toBeUndefined();
    expect(containerBricks(pod).bricks[0].state).toBe("terminated");
  });

  it("renders a healthy multi-container pod", () => {
    const pod = byName(all, "web-app");
    expect(podStatus(pod)).toBe("Running");
    expect(containerBricks(pod).bricks).toHaveLength(2);
    const row = pods.toRow(pod);
    expect(row.warning).toBeUndefined();
    expect(row.cells.owner).toMatchObject({ link: "ReplicaSet", ref: { resource: "replicasets", namespace: "frontend" } });
    expect(row.cells.node).toMatchObject({ ref: { resource: "nodes", namespace: undefined } });
    expect(row.actions).toEqual(["logs", "shell", "debug", "portForward", "edit", "describe", "copyName", "delete"]);
  });

  it("builds details with one section per container", async () => {
    const pod = byName(all, "web-app");
    const details = await pods.details(pod, emptyDetailContext);
    expect(details.title).toBe(`Pod: ${pod.metadata.name}`);
    const groups = details.sections.filter((s) => s.type === "group");
    expect(groups.map((g) => g.type === "group" && g.title)).toEqual(["nginx", "log-shipper"]);
  });
});
