// Fixtures captured from the development kind cluster (npm run fixtures).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KubeObject } from "../../src/kube/types";
import type { DetailContext } from "../../src/resources/descriptor";

export function fixture(name: string): KubeObject[] {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));
}

export function byName(items: KubeObject[], prefix: string): KubeObject {
  const found = items.find((o) => o.metadata.name.startsWith(prefix));
  if (!found) throw new Error(`No fixture object starting with ${prefix}`);
  return found;
}

/** A detail context that queries nothing. */
export const emptyDetailContext: DetailContext = { context: "test", list: async () => [], rowsOf: () => ({ columns: [], rows: [] }) };
