import { describe, expect, it } from "vitest";
import { avatarSvg, contextColor, contextInitials, shortContextName } from "../../../src/shared/clusterNames";
import { decodeBase64, encodeBase64 } from "../../../src/shared/encoding";
import { colorizeLogLine } from "../../../src/shared/logFormat";

describe("colorizeLogLine", () => {
  it("dims timestamps and colors errors", () => {
    expect(colorizeLogLine('2026-10-18T10:00:00.1Z level=error msg="x"')).toBe(
      '\x1b[2m2026-10-18T10:00:00.1Z\x1b[0m \x1b[31mlevel=error msg="x"\x1b[0m',
    );
  });

  it("colors container prefixes and warnings", () => {
    const line = colorizeLogLine("[pod/a/nginx] 2026-10-18T10:00:00Z WARN slow");
    expect(line).toContain("[pod/a/nginx] \x1b[0m");
    expect(line.startsWith("\x1b[")).toBe(true);
    expect(line).toContain("\x1b[33mWARN slow\x1b[0m");
  });

  it("gives each pod of a workload a stable color, never the error or warning ones", () => {
    const color = (pod: string) => {
      const line = colorizeLogLine(`[pod/${pod}/app] 2026-10-18T10:00:00Z ok`);
      return line.slice(2, line.indexOf("m"));
    };
    const pods = ["web-7d4f9", "web-x2m8k", "web-q5n3c", "web-a1b2c", "web-z9y8x"];
    expect(pods.map(color)).toEqual(pods.map(color));
    expect(new Set(pods.map(color)).size).toBeGreaterThan(1);
    for (const c of pods.map(color)) expect(["31", "33"]).not.toContain(c);
  });

  it("leaves plain lines untouched", () => {
    expect(colorizeLogLine("plain")).toBe("plain");
  });
});

describe("encodeBase64", () => {
  it("encodes the UTF-8 bytes, like Kubernetes", () => {
    for (const text of ["payments", "mot de passe é ✓", "", "a\nb"]) {
      expect(encodeBase64(text)).toBe(Buffer.from(text, "utf8").toString("base64"));
      expect(decodeBase64(encodeBase64(text))).toBe(text);
    }
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
