// Protected contexts: matching, and the actions they allow.
import { describe, expect, it } from "vitest";
import { allowedActions, contextProtection, globMatch, isAllowed } from "../../../src/shared/protection";
import { ALL_ACTIONS } from "../../../src/shared/view";

describe("protected contexts", () => {
  it("matches context names with glob patterns, ignoring case", () => {
    expect(globMatch("*prod*", "gke_infra-prod-1_europe-west1_main")).toBe(true);
    expect(globMatch("*prod*", "yc-yc-PROD-1")).toBe(true);
    expect(globMatch("*prod*", "kind-kubexplorer")).toBe(false);
    expect(globMatch("arn:aws:eks:*:cluster/live-?", "arn:aws:eks:eu-west-3:1234:cluster/live-a")).toBe(true);
    // Regular expression characters are literal.
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("(prod)", "(prod)")).toBe(true);
  });

  it("protects the contexts matching one of the patterns", () => {
    expect(contextProtection("gke_infra-prod-1", ["*prod*"], "confirm")).toBe("confirm");
    expect(contextProtection("gke_infra-prod-1", ["staging", " *prod* "], "readOnly")).toBe("readOnly");
    expect(contextProtection("kind-kubexplorer", ["*prod*"], "readOnly")).toBe("none");
    expect(contextProtection("anything", ["", "  "], "confirm")).toBe("none");
  });

  it("refuses changes and shells on read-only contexts, nothing on the others", () => {
    expect(allowedActions([...ALL_ACTIONS], "confirm")).toEqual([...ALL_ACTIONS]);
    expect(allowedActions(["logs", "shell", "debug", "portForward", "edit", "describe", "delete"], "readOnly")).toEqual([
      "logs",
      "portForward",
      "edit",
      "describe",
    ]);
    for (const action of ["scale", "restart", "rollback", "install", "reconcile", "suspend", "resume", "trigger"] as const)
      expect(isAllowed(action, "readOnly"), action).toBe(false);
    expect(isAllowed("delete", "none")).toBe(true);
  });
});
