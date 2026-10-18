// Helm releases and charts, through the helm binary (always with an explicit --kube-context).
// Releases and charts are exposed as Kubernetes-shaped objects: they are virtual lists of the store.

import type { ListOptions, VirtualSource } from "./client";
import { DEMO_CONTEXT } from "./demo";
import { runCommand } from "./kubectl";
import type { KubeObject, Logger } from "./types";
import { HELM_CHARTS, HELM_RELEASES } from "./virtualKinds";

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

export type ChartInfo = "chart" | "values" | "readme";

export interface HelmClient {
  listReleases(context: string, namespaces: string[]): Promise<KubeObject[]>;
  history(context: string, namespace: string, name: string): Promise<HelmRevision[]>;
  /** Notes printed by the chart at install time. */
  notes(context: string, namespace: string, name: string): Promise<string>;
  values(context: string, namespace: string, name: string, all: boolean): Promise<string>;
  manifest(context: string, namespace: string, name: string): Promise<string>;
  rollback(context: string, namespace: string, name: string, revision: number): Promise<void>;
  uninstall(context: string, namespace: string, name: string): Promise<void>;
  /** Charts of the locally configured repositories (they do not depend on the cluster, except for the demo). */
  searchCharts(context: string): Promise<KubeObject[]>;
  showChart(chart: string, what: ChartInfo, version?: string): Promise<string>;
  install(
    context: string,
    namespace: string,
    release: string,
    chart: string,
    version: string | undefined,
    valuesFile?: string,
  ): Promise<string>;
}

/** "2026-10-18 19:03:08.747354579 +0200 CEST" (helm list) -> ISO 8601. */
export function helmDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*([+-]\d{2}):?(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}${m[4]}:${m[5]}`;
}

/** "demo-app-0.1.0" -> { name: "demo-app", version: "0.1.0" }: the version starts at the last "-<digit>". */
export function splitChart(chart: string): { name: string; version: string } {
  const m = /^(.*)-(\d[\w.+-]*)$/.exec(chart);
  return m ? { name: m[1], version: m[2] } : { name: chart, version: "" };
}

/** A release as printed by `helm list -o json`. */
export interface RawRelease {
  name: string;
  namespace: string;
  revision: string | number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

/** A chart as printed by `helm search repo -o json`. */
export interface RawChart {
  name: string;
  version: string;
  app_version: string;
  description: string;
}

export function releaseObject(r: RawRelease): KubeObject {
  const { name: chartName, version } = splitChart(r.chart);
  return {
    apiVersion: "helm.sh/v3",
    kind: "HelmRelease",
    metadata: {
      name: r.name,
      namespace: r.namespace,
      uid: `helm-release:${r.namespace}/${r.name}`,
      creationTimestamp: helmDate(r.updated),
      resourceVersion: String(r.revision),
    },
    helm: { revision: Number(r.revision), status: r.status, chart: r.chart, chartName, chartVersion: version, appVersion: r.app_version },
  };
}

export function chartObject(c: RawChart): KubeObject {
  const [repo, ...rest] = c.name.split("/");
  return {
    apiVersion: "helm.sh/v3",
    kind: "HelmChart",
    metadata: { name: c.name, uid: `helm-chart:${c.name}` },
    helm: { repo, chart: rest.join("/"), version: c.version, appVersion: c.app_version, description: c.description },
  };
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;

export class HelmCli implements HelmClient {
  constructor(
    private readonly helmPath: () => string,
    private readonly log: Logger,
  ) {}

  private run(args: string[], timeoutMs = 60_000): Promise<string> {
    return runCommand(this.helmPath(), args, this.log, { timeoutMs });
  }

  async listReleases(context: string, namespaces: string[]): Promise<KubeObject[]> {
    const nsArgs = namespaces.length === 1 ? ["-n", namespaces[0]] : ["--all-namespaces"];
    const raw: RawRelease[] = JSON.parse((await this.run(["list", "--kube-context", context, ...nsArgs, "--all", "-o", "json"])) || "[]");
    return raw.filter((r) => namespaces.length <= 1 || namespaces.includes(r.namespace)).map(releaseObject);
  }

  async history(context: string, namespace: string, name: string): Promise<HelmRevision[]> {
    return JSON.parse(await this.run(["history", name, "--kube-context", context, "-n", namespace, "--max", "20", "-o", "json"]));
  }

  notes(context: string, namespace: string, name: string): Promise<string> {
    return this.run(["get", "notes", name, "--kube-context", context, "-n", namespace]);
  }

  values(context: string, namespace: string, name: string, all: boolean): Promise<string> {
    return this.run(["get", "values", name, "--kube-context", context, "-n", namespace, "-o", "yaml", ...(all ? ["--all"] : [])]);
  }

  manifest(context: string, namespace: string, name: string): Promise<string> {
    return this.run(["get", "manifest", name, "--kube-context", context, "-n", namespace]);
  }

  async rollback(context: string, namespace: string, name: string, revision: number): Promise<void> {
    await this.run(["rollback", name, String(revision), "--kube-context", context, "-n", namespace]);
  }

  async uninstall(context: string, namespace: string, name: string): Promise<void> {
    await this.run(["uninstall", name, "--kube-context", context, "-n", namespace]);
  }

  async searchCharts(): Promise<KubeObject[]> {
    let out: string;
    try {
      out = await this.run(["search", "repo", "-o", "json"]);
    } catch (err) {
      if (/no repositories/i.test(String(err)))
        throw new Error("No Helm repository configured (helm repo add <name> <url>)", { cause: err });
      throw err;
    }
    return (JSON.parse(out || "[]") as RawChart[]).map(chartObject);
  }

  showChart(chart: string, what: ChartInfo, version?: string): Promise<string> {
    return this.run(["show", what, chart, ...(version ? ["--version", version] : [])]);
  }

  install(
    context: string,
    namespace: string,
    release: string,
    chart: string,
    version: string | undefined,
    valuesFile?: string,
  ): Promise<string> {
    const args = ["install", release, chart, "--kube-context", context, "-n", namespace, "--create-namespace"];
    if (version) args.push("--version", version);
    if (valuesFile) args.push("-f", valuesFile);
    return this.run(args, INSTALL_TIMEOUT_MS);
  }
}

/** Fake Helm for the demo cluster (no process, no network). */
export class DemoHelm implements HelmClient {
  private releases: RawRelease[] = [
    {
      name: "grafana",
      namespace: "monitoring",
      revision: 4,
      updated: "2026-09-02 10:12:00.0 +0200 CEST",
      status: "deployed",
      chart: "grafana-8.5.1",
      app_version: "11.2.0",
    },
    {
      name: "ingress-nginx",
      namespace: "ingress-nginx",
      revision: 2,
      updated: "2026-06-11 08:30:00.0 +0200 CEST",
      status: "deployed",
      chart: "ingress-nginx-4.11.2",
      app_version: "1.11.2",
    },
    {
      name: "fraud-scorer",
      namespace: "payments",
      revision: 7,
      updated: "2026-10-15 16:40:00.0 +0200 CEST",
      status: "failed",
      chart: "fraud-scorer-0.7.3",
      app_version: "0.7.3",
    },
  ];

  async listReleases(_context: string, namespaces: string[]): Promise<KubeObject[]> {
    return this.releases.filter((r) => !namespaces.length || namespaces.includes(r.namespace)).map(releaseObject);
  }

  async history(_context: string, _namespace: string, name: string): Promise<HelmRevision[]> {
    const r = this.find(name);
    const count = Number(r.revision);
    return Array.from({ length: count }, (_, i) => {
      const revision = i + 1;
      const last = revision === count;
      return {
        revision,
        updated: new Date(Date.now() - (count - i) * 3 * 86_400_000).toISOString(),
        status: last ? r.status : "superseded",
        chart: r.chart,
        app_version: r.app_version,
        description:
          revision === 1
            ? "Install complete"
            : last && r.status === "failed"
              ? "Upgrade failed: timed out waiting for the condition"
              : "Upgrade complete",
      };
    });
  }

  async notes(_context: string, namespace: string, name: string): Promise<string> {
    return `${name} is running in the ${namespace} namespace (demo cluster).\n`;
  }

  async values(): Promise<string> {
    return "replicaCount: 2\nimage:\n  tag: latest\n# demo cluster\n";
  }

  async manifest(_context: string, namespace: string, name: string): Promise<string> {
    return `---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\n# demo cluster\n`;
  }

  async rollback(_context: string, _namespace: string, name: string): Promise<void> {
    const r = this.find(name);
    r.revision = Number(r.revision) + 1;
    r.status = "deployed";
    r.updated = new Date().toISOString();
  }

  async uninstall(_context: string, namespace: string, name: string): Promise<void> {
    this.releases = this.releases.filter((r) => !(r.name === name && r.namespace === namespace));
  }

  async searchCharts(): Promise<KubeObject[]> {
    return [
      {
        name: "bitnami/redis",
        version: "20.1.3",
        app_version: "7.4.0",
        description: "Redis(R) is an open source, advanced key-value store.",
      },
      {
        name: "grafana/grafana",
        version: "8.5.1",
        app_version: "11.2.0",
        description: "The leading tool for querying and visualizing time series and metrics.",
      },
      {
        name: "ingress-nginx/ingress-nginx",
        version: "4.11.2",
        app_version: "1.11.2",
        description: "Ingress controller for Kubernetes using NGINX as a reverse proxy.",
      },
    ].map(chartObject);
  }

  async showChart(chart: string, what: ChartInfo): Promise<string> {
    return `# ${what} of ${chart} (demo cluster)\n`;
  }

  async install(): Promise<string> {
    throw new Error("Installing charts is not available on the demo cluster");
  }

  private find(name: string): RawRelease {
    const r = this.releases.find((x) => x.name === name);
    if (!r) throw new Error(`Release ${name} not found`);
    return r;
  }
}

/** Routes to the real or demo Helm depending on the context. */
export class HelmRouter implements HelmClient {
  private readonly demo = new DemoHelm();

  constructor(private readonly real: HelmClient) {}

  private pick(context: string): HelmClient {
    return context === DEMO_CONTEXT ? this.demo : this.real;
  }

  listReleases(context: string, namespaces: string[]) {
    return this.pick(context).listReleases(context, namespaces);
  }
  history(context: string, namespace: string, name: string) {
    return this.pick(context).history(context, namespace, name);
  }
  notes(context: string, namespace: string, name: string) {
    return this.pick(context).notes(context, namespace, name);
  }
  values(context: string, namespace: string, name: string, all: boolean) {
    return this.pick(context).values(context, namespace, name, all);
  }
  manifest(context: string, namespace: string, name: string) {
    return this.pick(context).manifest(context, namespace, name);
  }
  rollback(context: string, namespace: string, name: string, revision: number) {
    return this.pick(context).rollback(context, namespace, name, revision);
  }
  uninstall(context: string, namespace: string, name: string) {
    return this.pick(context).uninstall(context, namespace, name);
  }
  searchCharts(context: string) {
    return this.pick(context).searchCharts(context);
  }
  showChart(chart: string, what: ChartInfo, version?: string) {
    return this.real.showChart(chart, what, version);
  }
  install(context: string, namespace: string, release: string, chart: string, version: string | undefined, valuesFile?: string) {
    return this.pick(context).install(context, namespace, release, chart, version, valuesFile);
  }
}

/** Store sources for the Helm lists. */
export function helmSources(helm: HelmClient): Record<string, VirtualSource> {
  return {
    [HELM_RELEASES]: { list: (context: string, opts: ListOptions) => helm.listReleases(context, opts.namespaces) },
    [HELM_CHARTS]: { list: (context: string) => helm.searchCharts(context) },
  };
}
