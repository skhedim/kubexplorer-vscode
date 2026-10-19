// Secrets edited with their values in clear: checked with a real YAML parser.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DECODED_COMMENT, decodeSecretYaml } from "../../../src/kube/secretYaml";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The YAML of kubectl get -o yaml for a Secret. */
function secretYaml(data: Record<string, string>, quoted = false): string {
  const entries = Object.entries(data).map(([k, v]) => `  ${k}: ${quoted ? JSON.stringify(v) : v}`);
  return [
    "apiVersion: v1",
    "data:",
    ...entries,
    "kind: Secret",
    "metadata:",
    "  name: db",
    "  namespace: payments",
    '  resourceVersion: "4242"',
    "type: Opaque",
    "",
  ].join("\n");
}

const TRICKY: Record<string, string> = {
  password: "p@ss: #word",
  empty: "",
  "tls.crt": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  script: "#!/bin/sh\necho 'hi'\n\n",
  noNewline: "line 1\nline 2",
  indented: "  starts with spaces\nthen text",
  windows: "a\r\nb",
  yes: "yes",
  number: "0123",
  unicode: "héllo ✓",
  json: '{"auths":{"registry":{"auth":"eA=="}}}',
};

describe("decodeSecretYaml", () => {
  it("moves the text values to stringData, exactly, whatever their content", () => {
    const yaml = secretYaml(Object.fromEntries(Object.entries(TRICKY).map(([k, v]) => [k, b64(v)])));
    const decoded = decodeSecretYaml(yaml);
    const doc = parse(decoded);
    expect(doc.stringData).toEqual(TRICKY);
    expect(doc.data).toBeUndefined();
    expect(doc.metadata).toEqual({ name: "db", namespace: "payments", resourceVersion: "4242" });
    expect(decoded).toContain(DECODED_COMMENT);
    expect(decoded).toContain("  tls.crt: |\n    -----BEGIN CERTIFICATE-----\n");
  });

  it("keeps binary values in data", () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).toString("base64");
    const doc = parse(decodeSecretYaml(secretYaml({ "logo.png": binary, user: b64("admin") })));
    expect(doc.data).toEqual({ "logo.png": binary });
    expect(doc.stringData).toEqual({ user: "admin" });
  });

  it("reads quoted values and keys", () => {
    const doc = parse(decodeSecretYaml(secretYaml({ '"true"': b64("x"), key: b64("v") }, true)));
    expect(doc.stringData).toEqual({ true: "x", key: "v" });
  });

  it("leaves a Secret without data untouched", () => {
    const yaml = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: empty\ntype: Opaque\n";
    expect(decodeSecretYaml(yaml)).toBe(yaml);
  });

  it("refuses a data block it cannot read", () => {
    expect(() => decodeSecretYaml("data:\n  - not a map\nkind: Secret\n")).toThrow(/Unexpected line/);
  });
});
