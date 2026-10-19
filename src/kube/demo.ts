// In-memory demo cluster. It produces real `kubectl get -o json` shaped objects, so the demo goes
// through exactly the same mapping code as a real cluster.
// No Node.js imports: it is also bundled into the browser preview.

import type { ExecSpec, KubeClient, ListOptions, ManyResult, NamedKind, Stoppable } from "./client";
import type { ContextInfo, KindTarget, KubeObject, LogOptions, ObjectTarget } from "./types";

export const DEMO_CONTEXT = "kubexplorer-demo";

interface AppSpec {
  ns: string;
  name: string;
  replicas: number;
  containers: { name: string; image: string; port?: number }[];
  trouble?: "crash" | "pending" | "creating" | "restarts";
  ageDays: number;
}

const APPS: AppSpec[] = [
  {
    ns: "frontend",
    name: "web-app",
    replicas: 3,
    containers: [
      { name: "nginx", image: "nginx:1.27-alpine", port: 80 },
      { name: "log-shipper", image: "busybox:1.36" },
    ],
    ageDays: 41,
  },
  {
    ns: "frontend",
    name: "web-bff",
    replicas: 2,
    containers: [{ name: "bff", image: "ghcr.io/acme/web-bff:1.9.0", port: 3000 }],
    ageDays: 41,
    trouble: "restarts",
  },
  {
    ns: "payments",
    name: "payments-api",
    replicas: 2,
    containers: [{ name: "api", image: "ghcr.io/acme/payments-api:4.2.0", port: 9090 }],
    ageDays: 12,
  },
  {
    ns: "payments",
    name: "fraud-scorer",
    replicas: 1,
    containers: [{ name: "scorer", image: "ghcr.io/acme/fraud-scorer:0.7.3" }],
    ageDays: 3,
    trouble: "crash",
  },
  {
    ns: "payments",
    name: "ledger-worker",
    replicas: 1,
    containers: [{ name: "worker", image: "ghcr.io/acme/ledger-worker:4.2.0" }],
    ageDays: 12,
    trouble: "pending",
  },
  {
    ns: "monitoring",
    name: "grafana",
    replicas: 1,
    containers: [{ name: "grafana", image: "grafana/grafana:11.2.0", port: 3000 }],
    ageDays: 120,
  },
  {
    ns: "kube-system",
    name: "coredns",
    replicas: 2,
    containers: [{ name: "coredns", image: "registry.k8s.io/coredns/coredns:v1.11.3", port: 53 }],
    ageDays: 310,
  },
  {
    ns: "default",
    name: "search-indexer",
    replicas: 1,
    containers: [{ name: "indexer", image: "ghcr.io/acme/search-indexer:1.0.0-rc2" }],
    ageDays: 0.02,
    trouble: "creating",
  },
];

const NODES = ["demo-control-plane", "demo-worker", "demo-worker2"];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

export class DemoClient implements KubeClient {
  private readonly rand = rng(42);
  private objects = new Map<string, KubeObject[]>();
  /** Demo bookkeeping per Deployment uid: its spec and current ReplicaSet hash. */
  private readonly apps = new Map<string, { app: AppSpec; hash: string }>();
  private serial = 0;

  constructor() {
    this.seed();
  }

  private app(deployment: KubeObject): { app: AppSpec; hash: string } {
    const entry = this.apps.get(deployment.metadata.uid);
    if (!entry) throw new Error(`${deployment.metadata.name} is not a demo Deployment`);
    return entry;
  }

  private replicaSetName(deployment: KubeObject): string {
    return `${deployment.metadata.name}-${this.app(deployment).hash}`;
  }

  private suffix(n: number): string {
    const chars = "bcdfghjklmnpqrstvwxz2456789";
    return Array.from({ length: n }, () => chars[Math.floor(this.rand() * chars.length)]).join("");
  }

  private meta(
    name: string,
    namespace: string | undefined,
    ageDays: number,
    extra: Partial<KubeObject["metadata"]> = {},
  ): KubeObject["metadata"] {
    return { name, namespace, uid: `demo-${++this.serial}-${this.suffix(8)}`, creationTimestamp: iso(ageDays), ...extra };
  }

  private add(kind: string, obj: KubeObject): void {
    const list = this.objects.get(kind) ?? [];
    list.push(obj);
    this.objects.set(kind, list);
  }

  private seed(): void {
    for (const ns of ["default", "kube-system", "kube-public", "frontend", "payments", "monitoring"]) {
      this.add("namespaces", {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: this.meta(ns, undefined, ns.startsWith("kube") || ns === "default" ? 310 : 120),
        status: { phase: "Active" },
      });
    }
    NODES.forEach((n, i) =>
      this.add("nodes", {
        apiVersion: "v1",
        kind: "Node",
        metadata: this.meta(n, undefined, 310, {
          labels: { "kubernetes.io/hostname": n, ...(i === 0 ? { "node-role.kubernetes.io/control-plane": "" } : {}) },
        }),
        spec: i === 0 ? { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] } : {},
        status: {
          capacity: { cpu: "8", memory: "16303384Ki", pods: "110" },
          allocatable: { cpu: "8", memory: "16200984Ki", pods: "110" },
          nodeInfo: {
            kubeletVersion: "v1.31.0",
            osImage: "Debian GNU/Linux 12",
            containerRuntimeVersion: "containerd://1.7.18",
            kernelVersion: "5.15.133",
          },
          addresses: [{ type: "InternalIP", address: `172.18.0.${i + 2}` }],
          conditions: [{ type: "Ready", status: "True", message: "kubelet is posting ready status" }],
        },
      }),
    );
    for (const app of APPS) this.createDeployment(app);
    this.add("configmaps", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: this.meta("web-app-config", "frontend", 41),
      data: {
        APP_ENV: "production",
        FEATURE_FLAGS: "new-checkout,dark-mode",
        "nginx.conf": "server {\n  listen 80;\n  location / { return 200 'ok'; }\n}\n",
      },
    });
    this.add("secrets", {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: this.meta("payments-db", "payments", 12),
      data: { username: "cGF5bWVudHM=", password: "c2VjcmV0" },
    });
    this.add("services", {
      apiVersion: "v1",
      kind: "Service",
      metadata: this.meta("web-app", "frontend", 41),
      spec: {
        type: "ClusterIP",
        clusterIP: "10.96.14.201",
        ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }],
        selector: { "app.kubernetes.io/name": "web-app" },
      },
      status: { loadBalancer: {} },
    });
    this.add("services", {
      apiVersion: "v1",
      kind: "Service",
      metadata: this.meta("payments-api", "payments", 12),
      spec: {
        type: "NodePort",
        clusterIP: "10.96.88.12",
        ports: [{ name: "grpc", port: 9090, nodePort: 31090, protocol: "TCP" }],
        selector: { "app.kubernetes.io/name": "payments-api" },
      },
      status: { loadBalancer: {} },
    });
    const crashPod = this.objects.get("pods")!.find((p) => p.metadata.name.startsWith("fraud-scorer"))!;
    this.add("events", {
      apiVersion: "v1",
      kind: "Event",
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container scorer in pod " + crashPod.metadata.name,
      count: 37,
      metadata: this.meta(`${crashPod.metadata.name}.17f2`, "payments", 0.01),
      involvedObject: { kind: "Pod", name: crashPod.metadata.name, namespace: "payments" },
      lastTimestamp: iso(0.001),
      source: { component: "kubelet" },
    });
    const pendingPod = this.objects.get("pods")!.find((p) => p.metadata.name.startsWith("ledger-worker"))!;
    this.add("events", {
      apiVersion: "v1",
      kind: "Event",
      type: "Warning",
      reason: "FailedScheduling",
      message: "0/3 nodes are available: 3 Insufficient memory.",
      count: 112,
      metadata: this.meta(`${pendingPod.metadata.name}.18a1`, "payments", 0.2),
      involvedObject: { kind: "Pod", name: pendingPod.metadata.name, namespace: "payments" },
      lastTimestamp: iso(0.002),
      source: { component: "default-scheduler" },
    });
  }

  private createDeployment(app: AppSpec): void {
    const hash = this.suffix(10);
    const selector = { "app.kubernetes.io/name": app.name };
    const template = {
      metadata: { labels: selector },
      spec: {
        containers: app.containers.map((c) => ({
          name: c.name,
          image: c.image,
          ports: c.port ? [{ containerPort: c.port, protocol: "TCP" }] : undefined,
        })),
      },
    };
    this.add("deployments", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: this.meta(app.name, app.ns, app.ageDays, {
        labels: { ...selector, "app.kubernetes.io/part-of": app.ns },
        annotations: { "deployment.kubernetes.io/revision": "3" },
      }),
      spec: { replicas: app.replicas, selector: { matchLabels: selector }, strategy: { type: "RollingUpdate" }, template },
      status: {},
    });
    this.apps.set(this.objects.get("deployments")!.at(-1)!.metadata.uid, { app, hash });
    this.add("replicasets", {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: this.meta(`${app.name}-${hash}`, app.ns, app.ageDays, {
        labels: selector,
        ownerReferences: [{ kind: "Deployment", name: app.name, controller: true }],
      }),
      spec: { replicas: app.replicas, selector: { matchLabels: selector }, template },
      status: {},
    });
    for (let i = 0; i < app.replicas; i++) this.createPod(app, hash, i, Math.min(app.ageDays, this.rand() * app.ageDays + 0.01));
    this.recompute();
  }

  private createPod(app: AppSpec, hash: string, index: number, ageDays: number): void {
    const affected = app.trouble && (app.trouble !== "restarts" || index === 0);
    const statuses = app.containers.map((c, ci) => {
      const base = {
        name: c.name,
        image: c.image,
        ready: true,
        restartCount: 0,
        state: { running: { startedAt: iso(ageDays) } } as Record<string, unknown>,
      };
      if (!affected || ci > 0) return base;
      switch (app.trouble) {
        case "crash":
          return {
            ...base,
            ready: false,
            restartCount: 37,
            state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
            lastState: { terminated: { exitCode: 1, reason: "Error" } },
          };
        case "creating":
          return { ...base, ready: false, state: { waiting: { reason: "ContainerCreating" } } };
        case "restarts":
          return { ...base, restartCount: 4, lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } };
        default:
          return base;
      }
    });
    const pending = affected && app.trouble === "pending";
    const ready = statuses.every((s) => s.ready);
    this.add("pods", {
      apiVersion: "v1",
      kind: "Pod",
      metadata: this.meta(`${app.name}-${hash}-${this.suffix(5)}`, app.ns, ageDays, {
        labels: { "app.kubernetes.io/name": app.name, "pod-template-hash": hash },
        ownerReferences: [{ kind: "ReplicaSet", name: `${app.name}-${hash}`, controller: true }],
      }),
      spec: {
        nodeName: pending ? undefined : NODES[1 + Math.floor(this.rand() * 2)],
        serviceAccountName: "default",
        containers: app.containers.map((c) => ({
          name: c.name,
          image: c.image,
          ports: c.port ? [{ containerPort: c.port, protocol: "TCP" }] : undefined,
        })),
      },
      status: pending
        ? {
            phase: "Pending",
            qosClass: "Burstable",
            conditions: [
              {
                type: "PodScheduled",
                status: "False",
                reason: "Unschedulable",
                message: "0/3 nodes are available: 3 Insufficient memory.",
              },
            ],
          }
        : {
            phase: "Running",
            qosClass: this.rand() > 0.5 ? "Guaranteed" : "Burstable",
            podIP: `10.244.${1 + Math.floor(this.rand() * 2)}.${2 + Math.floor(this.rand() * 250)}`,
            hostIP: `172.18.0.${3 + Math.floor(this.rand() * 2)}`,
            containerStatuses: statuses,
            conditions: [
              { type: "Initialized", status: "True" },
              { type: "Ready", status: ready ? "True" : "False" },
              { type: "ContainersReady", status: ready ? "True" : "False" },
              { type: "PodScheduled", status: "True" },
            ],
          },
    });
  }

  /** Recomputes Deployment/ReplicaSet statuses from their pods, as the controllers would. */
  private recompute(): void {
    const pods = this.objects.get("pods") ?? [];
    for (const d of this.objects.get("deployments") ?? []) {
      const owned = pods.filter((p) => p.metadata.ownerReferences?.[0]?.name === this.replicaSetName(d));
      const ready = owned.filter((p) =>
        p.status?.conditions?.some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True"),
      ).length;
      d.status = {
        replicas: owned.length,
        updatedReplicas: owned.length,
        readyReplicas: ready,
        availableReplicas: ready,
        conditions: [
          {
            type: "Available",
            status: ready > 0 || d.spec.replicas === 0 ? "True" : "False",
            message: ready ? "Deployment has minimum availability." : "Deployment does not have minimum availability.",
          },
          { type: "Progressing", status: "True", message: `ReplicaSet "${this.replicaSetName(d)}" has successfully progressed.` },
          ...(this.app(d).app.trouble === "crash"
            ? [{ type: "ReplicaFailure", status: "True", message: "Back-off restarting failed container" }]
            : []),
        ],
      };
      const rs = (this.objects.get("replicasets") ?? []).find((r) => r.metadata.name === this.replicaSetName(d));
      if (rs) rs.status = { replicas: owned.length, readyReplicas: ready, availableReplicas: ready };
    }
  }

  private delay<T>(value: T, ms = 80): Promise<T> {
    return new Promise((r) => setTimeout(() => r(value), ms));
  }

  private find(t: ObjectTarget): KubeObject | undefined {
    return (this.objects.get(t.kubectlName) ?? []).find(
      (o) => o.metadata.name === t.name && (!t.namespaced || o.metadata.namespace === t.namespace),
    );
  }

  listContexts(): Promise<ContextInfo[]> {
    return this.delay([{ name: DEMO_CONTEXT, cluster: "demo", user: "demo", current: false, demo: true }]);
  }

  /** Fake but stable metrics (derived from names), shaped like metrics-server output. */
  private metrics(kind: string): KubeObject[] {
    const seed = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    // A slow wave per object, so that usage charts move like a real cluster.
    const wave = (s: string) => 0.8 + 0.2 * Math.sin(Date.now() / 120_000 + (seed(s) % 628) / 100);
    if (kind === "nodes.metrics.k8s.io") {
      return (this.objects.get("nodes") ?? []).map((n) => ({
        kind: "NodeMetrics",
        metadata: { name: n.metadata.name, uid: `m-${n.metadata.uid}` },
        usage: {
          cpu: `${Math.round((400 + (seed(n.metadata.name) % 3000)) * wave(n.metadata.name))}m`,
          memory: `${Math.round((2000 + (seed(n.metadata.name) % 9000)) * wave(`${n.metadata.name}m`))}Mi`,
        },
      }));
    }
    return (this.objects.get("pods") ?? [])
      .filter((p) => p.status?.phase === "Running")
      .map((p) => ({
        kind: "PodMetrics",
        metadata: { name: p.metadata.name, namespace: p.metadata.namespace, uid: `m-${p.metadata.uid}` },
        containers: (p.spec?.containers ?? []).map((c: { name: string }) => ({
          name: c.name,
          usage: {
            cpu: `${Math.round((seed(p.metadata.name + c.name) % 250) * wave(p.metadata.name))}m`,
            memory: `${Math.round((20 + (seed(c.name + p.metadata.name) % 400)) * wave(c.name + p.metadata.name))}Mi`,
          },
        })),
      }));
  }

  list(_context: string, kind: KindTarget, opts: ListOptions): Promise<KubeObject[]> {
    if (kind.kubectlName.endsWith(".metrics.k8s.io")) {
      const items = this.metrics(kind.kubectlName).filter(
        (o) => !kind.namespaced || !opts.namespaces.length || opts.namespaces.includes(o.metadata.namespace ?? ""),
      );
      return this.delay(items);
    }
    let items = this.objects.get(kind.kubectlName) ?? [];
    if (kind.namespaced && opts.namespaces.length) items = items.filter((o) => opts.namespaces.includes(o.metadata.namespace ?? ""));
    if (opts.labelSelector) {
      const pairs = opts.labelSelector.split(",").map((p) => p.split("="));
      items = items.filter((o) => pairs.every(([k, v]) => o.metadata.labels?.[k] === v));
    }
    return this.delay(structuredClone(items));
  }

  async listMany(context: string, kinds: NamedKind[], opts: { namespace?: string } = {}): Promise<ManyResult> {
    const served = kinds.filter((k) => this.objects.has(k.kubectlName) || k.kubectlName.endsWith(".metrics.k8s.io"));
    const lists = await Promise.all(served.map((k) => this.list(context, k, { namespaces: opts.namespace ? [opts.namespace] : [] })));
    return {
      items: Object.fromEntries(served.map((k, i) => [k.kubectlName, lists[i].map((o) => ({ ...o, kind: k.kindName }))])),
      missing: kinds.filter((k) => !served.includes(k)).map((k) => k.kubectlName),
    };
  }

  async getYaml(_context: string, t: ObjectTarget): Promise<string> {
    const o = this.find(t);
    if (!o) throw new Error(`${t.kubectlName} "${t.name}" introuvable`);
    // Minimal YAML serialization, good enough for the demo.
    return toYaml(o) + "\n";
  }

  async replaceYaml(): Promise<string> {
    return this.delay("demo cluster: change ignored");
  }

  async describe(_context: string, t: ObjectTarget): Promise<string> {
    const o = this.find(t);
    return `Name:         ${t.name}\nNamespace:    ${t.namespace ?? "<none>"}\nLabels:       ${Object.entries(o?.metadata.labels ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n              ")}\n\n(demo cluster: simplified kubectl describe output)\n`;
  }

  async delete(_context: string, t: ObjectTarget): Promise<void> {
    const o = this.find(t);
    if (!o) return;
    this.objects.set(
      t.kubectlName,
      (this.objects.get(t.kubectlName) ?? []).filter((x) => x !== o),
    );
    if (t.kubectlName === "pods") {
      // Like a real ReplicaSet: a replacement shows up a few seconds later.
      const d = (this.objects.get("deployments") ?? []).find((x) => o.metadata.ownerReferences?.[0]?.name === this.replicaSetName(x));
      if (d) setTimeout(() => (this.createPod(this.app(d).app, this.app(d).hash, 99, 0.0001), this.recompute()), 1500);
    }
    if (t.kubectlName === "deployments") {
      this.objects.set(
        "pods",
        (this.objects.get("pods") ?? []).filter((p) => p.metadata.ownerReferences?.[0]?.name !== this.replicaSetName(o)),
      );
    }
    this.recompute();
    await this.delay(undefined);
  }

  async scale(_context: string, t: ObjectTarget, replicas: number): Promise<void> {
    const d = this.find(t);
    if (!(d && this.apps.has(d.metadata.uid))) throw new Error("Scaling this kind is not supported on the demo cluster");
    d.spec.replicas = replicas;
    const pods = this.objects.get("pods") ?? [];
    const owned = pods.filter((p) => p.metadata.ownerReferences?.[0]?.name === this.replicaSetName(d));
    const drop = new Set(owned.slice(replicas));
    this.objects.set(
      "pods",
      pods.filter((p) => !drop.has(p)),
    );
    for (let i = owned.length; i < replicas; i++) this.createPod(this.app(d).app, this.app(d).hash, i, 0.0001);
    this.recompute();
    await this.delay(undefined);
  }

  async restart(_context: string, t: ObjectTarget): Promise<void> {
    const d = this.find(t);
    if (!(d && this.apps.has(d.metadata.uid))) throw new Error("Restarting this kind is not supported on the demo cluster");
    const old = this.replicaSetName(d);
    this.objects.set(
      "pods",
      (this.objects.get("pods") ?? []).filter((p) => p.metadata.ownerReferences?.[0]?.name !== old),
    );
    this.app(d).hash = this.suffix(10);
    for (let i = 0; i < d.spec.replicas; i++) this.createPod(this.app(d).app, this.app(d).hash, i, 0.0001);
    this.recompute();
    await this.delay(undefined);
  }

  async patch(_context: string, t: ObjectTarget, patch: object): Promise<void> {
    const o = this.find(t);
    if (!o) throw new Error(`${t.kubectlName} "${t.name}" not found`);
    mergePatch(o, patch);
    await this.delay(undefined);
  }

  async getRaw(): Promise<string> {
    throw new Error("Raw API requests are not available on the demo cluster");
  }

  async triggerCronJob(_context: string, _namespace: string, name: string): Promise<string> {
    return `${name}-manual-demo`;
  }

  streamLogs(_context: string, o: LogOptions, onData: (chunk: string) => void, onEnd: (error?: string) => void): Stoppable {
    const crash = o.pod.startsWith("fraud-scorer");
    const msgs = crash
      ? ["loading model /models/scorer.onnx", 'level=error msg="model not found"', "panic: runtime error: invalid memory address"]
      : [
          'level=info msg="GET /healthz 200" latency_ms=1',
          'level=info msg="POST /api/v1/orders 201" latency_ms=48',
          'level=warn msg="slow query on table orders" latency_ms=812',
          'level=info msg="cache hit ratio=0.93"',
          'level=error msg="upstream timeout" upstream=bank-gateway',
        ];
    let i = 0;
    // The logs of a workload: lines of its pods, prefixed like kubectl logs --prefix.
    const prefix = () => (o.selector ? `[pod/${o.pod.split("/").pop()}-${["7d4f9", "x2m8k", "q5n3c"][i % 3]}/app] ` : "");
    const line = () => `${prefix()}${new Date(Date.now() - 1000 * (60 - i)).toISOString()} ${msgs[i++ % msgs.length]}\n`;
    const t0 = setTimeout(() => onData(Array.from({ length: crash ? 3 : 40 }, line).join("")), 100);
    if (crash || !o.follow || o.previous) {
      const t1 = setTimeout(() => onEnd(), 250);
      return { stop: () => (clearTimeout(t0), clearTimeout(t1)) };
    }
    const timer = setInterval(() => onData(line()), 1500);
    return { stop: () => (clearTimeout(t0), clearInterval(timer)) };
  }

  execSpec(): ExecSpec | undefined {
    return undefined;
  }

  debugSpec(): ExecSpec | undefined {
    return undefined;
  }
}

/** RFC 7386 JSON merge patch, in place: null removes a field. */
function mergePatch(target: Record<string, unknown>, patch: object): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === "object" && !Array.isArray(v)) {
      if (typeof target[k] !== "object" || target[k] === null || Array.isArray(target[k])) target[k] = {};
      mergePatch(target[k] as Record<string, unknown>, v);
    } else target[k] = v;
  }
}

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value.map((v) => `${pad}- ${toYaml(v, indent + 1).trimStart()}`).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return "{}";
    return entries
      .map(([k, v]) => {
        const nested = v && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length);
        return nested ? `${pad}${k}:\n${toYaml(v, indent + 1)}` : `${pad}${k}: ${toYaml(v, 0)}`;
      })
      .join("\n");
  }
  if (typeof value === "string") return /^[\w./:-]+$/.test(value) && !/^(true|false|null|\d+)$/.test(value) ? value : JSON.stringify(value);
  return String(value);
}
