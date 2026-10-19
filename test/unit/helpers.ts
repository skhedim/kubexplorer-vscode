// Fixtures captured from the development kind cluster (npm run fixtures).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KubeClient, ManyResult, NamedKind } from "../../src/kube/client";
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

/** A client serving the fixtures of the development cluster, with a delay, counting the requests in flight. */
export function fakeFleetClient(opts: { unreachable?: string[]; withoutFlux?: string[] } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: { context: string; kinds: string[]; namespace?: string }[] = [];
  const byKind: Record<string, KubeObject[]> = {
    Node: fixture("nodes"),
    Kustomization: fixture("flux-kustomizations"),
    HelmRelease: fixture("flux-helmreleases"),
    GitRepository: fixture("flux-gitrepositories"),
    Deployment: fixture("deployments"),
    Pod: fixture("pods"),
  };
  const client = {
    async listMany(context: string, kinds: NamedKind[], o: { namespace?: string } = {}): Promise<ManyResult> {
      calls.push({ context, kinds: kinds.map((k) => k.kindName), namespace: o.namespace });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (opts.unreachable?.includes(context)) throw new Error("Unable to connect to the server: i/o timeout\nmore");
      const flux = (k: NamedKind) => k.kubectlName.includes("fluxcd.io");
      const served = kinds.filter((k) => !(flux(k) && opts.withoutFlux?.includes(context)) && (byKind[k.kindName] || !flux(k)));
      return {
        items: Object.fromEntries(
          served.map((k) => [
            k.kubectlName,
            (byKind[k.kindName] ?? []).filter((x) => !o.namespace || x.metadata.namespace === o.namespace),
          ]),
        ),
        missing: kinds.filter((k) => !served.includes(k)).map((k) => k.kubectlName),
      };
    },
  } as unknown as KubeClient;
  return { client, calls, maxInFlight: () => maxInFlight };
}
