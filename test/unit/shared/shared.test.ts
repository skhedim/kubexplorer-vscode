import { describe, expect, it } from "vitest";
import { avatarSvg, contextColor, contextInitials, shortContextName } from "../../../src/shared/clusterNames";
import { decodeBase64 } from "../../../src/shared/encoding";
import { colorizeLogLine } from "../../../src/shared/logFormat";

describe("colorizeLogLine", () => {
  it("dims timestamps and colors errors", () => {
    expect(colorizeLogLine('2026-10-18T10:00:00.1Z level=error msg="x"')).toBe(
      '\x1b[2m2026-10-18T10:00:00.1Z\x1b[0m \x1b[31mlevel=error msg="x"\x1b[0m',
    );
  });

  it("colors container prefixes and warnings", () => {
    const line = colorizeLogLine("[pod/a/nginx] 2026-10-18T10:00:00Z WARN slow");
    expect(line).toContain("\x1b[36m[pod/a/nginx] \x1b[0m");
    expect(line).toContain("\x1b[33mWARN slow\x1b[0m");
  });

  it("leaves plain lines untouched", () => {
    expect(colorizeLogLine("plain")).toBe("plain");
  });
});

describe("decodeBase64", () => {
  it("decodes UTF-8 values", () => {
    expect(decodeBase64("cGF5bWVudHM=")).toBe("payments");
    expect(decodeBase64(Buffer.from("mot de passe é").toString("base64"))).toBe("mot de passe é");
  });
});

describe("cluster names", () => {
  it.each([
    ["kind-kubexplorer", "KK", "kind-kubexplorer"],
    ["gke_project_europe-west4_prod-1", "P1", "prod-1"],
    ["minikube", "MI", "minikube"],
  ])("%s -> initials %s, short name %s", (name, initials, short) => {
    expect(contextInitials(name)).toBe(initials);
    expect(shortContextName(name)).toBe(short);
  });

  it("derives a stable color and avatar from the name", () => {
    expect(contextColor("prod")).toMatch(/^#[0-9a-f]{6}$/);
    expect(contextColor("prod")).toBe(contextColor("prod"));
    expect(contextColor("prod")).not.toBe(contextColor("staging"));
    expect(avatarSvg("kind-kubexplorer")).toContain(">KK</text>");
  });

  it("shortens long names", () => {
    expect(shortContextName("a-very-long-context-name-for-tests")).toBe("a-very-long-context-nam…");
  });
});
