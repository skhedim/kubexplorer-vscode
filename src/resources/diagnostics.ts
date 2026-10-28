// Diagnostics of the cluster, like Popeye or the pulse of k9s: rules over the objects of the cluster that report what
// is broken (errors), what puts the applications at risk (warnings), and what is worth a look (info).
// Shown as an overview page, and published in the Problems view of VS Code. Pure module, unit tested.

import type { KubeObject } from "../kube/types";
import type { DetailItem, OverviewCard, OverviewData, OverviewTable, ResourceRef, Row, Tone } from "../shared/view";
import type { OverviewInput, OverviewPage } from "./overview";

export type Severity = "error" | "warning" | "info";

export const CATEGORIES = ["Nodes", "Workloads", "Pods", "Network", "Configuration", "Storage", "Autoscaling"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Problem {
  ref: ResourceRef;
  kind: string;
  category: Category;
  severity: Severity;
  /** Identifier of the rule (e.g. "container-crash"): the code of the problem in VS Code. */
  rule: string;
  message: string;
}

/** The lists the rules read (registry identifiers). */
const RESOURCES = [
  "nodes",
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "jobs",
  "cronjobs",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "serviceaccounts",
  "persistentvolumeclaims",
  "persistentvolumes",
  "horizontalpodautoscalers",
  "poddisruptionbudgets",
] as const;

const KIND: Record<string, string> = {
  nodes: "Node",
  pods: "Pod",
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
  jobs: "Job",
  cronjobs: "CronJob",
  services: "Service",
  ingresses: "Ingress",
  configmaps: "ConfigMap",
  secrets: "Secret",
  serviceaccounts: "ServiceAccount",
  persistentvolumeclaims: "PersistentVolumeClaim",
  persistentvolumes: "PersistentVolume",
  horizontalpodautoscalers: "HorizontalPodAutoscaler",
  poddisruptionbudgets: "PodDisruptionBudget",
};

/** Waiting reasons of a container that will not fix themselves. */
const BROKEN_WAITING = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);
/** Restarts beyond which a running container is reported. */
const RESTARTS_WARNING = 5;
/** A pod not ready for longer than this is reported. */
const NOT_READY_GRACE_MS = 5 * 60_000;
/** Namespaces of Kubernetes itself: their objects are checked for health, not for good practices. */
const SYSTEM_NAMESPACE = /^kube-/;
const NODE_PRESSURES = ["MemoryPressure", "DiskPressure", "PIDPressure"];

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
  ready?: boolean;
  state?: { waiting?: { reason?: string; message?: string } };
  lastState?: { terminated?: { reason?: string } };
}

function condition(o: KubeObject, type: string): Condition | undefined {
  return (o.status?.conditions as Condition[] | undefined)?.find((c) => c.type === type);
}

/** The first line of a message, short enough for a list. */
function brief(message: string | undefined, max = 140): string {
  const line = (message ?? "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The pod spec of a workload: its own, or the template of its pods. */
function podSpec(resource: string, o: KubeObject): KubeObject | undefined {
  if (resource === "pods") return o.spec;
  if (resource === "cronjobs") return o.spec?.jobTemplate?.spec?.template?.spec;
  return o.spec?.template?.spec;
}

interface Reference {
  resource: "configmaps" | "secrets" | "persistentvolumeclaims" | "serviceaccounts";
  name: string;
  optional?: boolean;
}

/** The objects a pod spec uses; references every pod has (kube-root-ca.crt) are left out. */
function references(spec: KubeObject): Reference[] {
  const refs: Reference[] = [];
  for (const v of spec.volumes ?? []) {
    if (v.configMap) refs.push({ resource: "configmaps", name: v.configMap.name, optional: v.configMap.optional });
    if (v.secret) refs.push({ resource: "secrets", name: v.secret.secretName, optional: v.secret.optional });
    if (v.persistentVolumeClaim) refs.push({ resource: "persistentvolumeclaims", name: v.persistentVolumeClaim.claimName });
    for (const p of v.projected?.sources ?? []) {
      if (p.configMap) refs.push({ resource: "configmaps", name: p.configMap.name, optional: p.configMap.optional });
      if (p.secret) refs.push({ resource: "secrets", name: p.secret.name, optional: p.secret.optional });
    }
  }
  for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    for (const f of c.envFrom ?? []) {
      if (f.configMapRef) refs.push({ resource: "configmaps", name: f.configMapRef.name, optional: f.configMapRef.optional });
      if (f.secretRef) refs.push({ resource: "secrets", name: f.secretRef.name, optional: f.secretRef.optional });
    }
    for (const e of c.env ?? []) {
      const from = e.valueFrom ?? {};
      if (from.configMapKeyRef)
        refs.push({ resource: "configmaps", name: from.configMapKeyRef.name, optional: from.configMapKeyRef.optional });
      if (from.secretKeyRef) refs.push({ resource: "secrets", name: from.secretKeyRef.name, optional: from.secretKeyRef.optional });
    }
  }
  for (const s of spec.imagePullSecrets ?? []) refs.push({ resource: "secrets", name: s.name });
  if (spec.serviceAccountName) refs.push({ resource: "serviceaccounts", name: spec.serviceAccountName });
  return refs.filter((r) => r.name && r.name !== "kube-root-ca.crt");
}

/** An image without tag, or tagged latest: the version it runs can change on any restart. */
function floatingImage(image: string | undefined): boolean {
  if (!image || image.includes("@")) return false;
  const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
  return !tag || tag === "latest";
}

const matches = (selector: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  Object.entries(selector ?? {}).every(([k, v]) => labels?.[k] === v);

const key = (namespace: string | undefined, name: string) => `${namespace ?? ""}/${name}`;

/** Runs every rule. `now` makes the time-based rules testable. */
export function diagnose(input: OverviewInput, now = Date.now()): Problem[] {
  const { lists, errors } = input;
  const items = (resource: string) => lists[resource] ?? [];
  /** Names of a list that could be read, to report missing objects; undefined when it could not. */
  const names = (resource: string) =>
    lists[resource] && !errors[resource] ? new Set(items(resource).map((o) => key(o.metadata.namespace, o.metadata.name))) : undefined;
  const problems: Problem[] = [];
  const report = (resource: string, o: KubeObject, category: Category, severity: Severity, rule: string, message: string) =>
    problems.push({
      ref: { resource, namespace: o.metadata.namespace, name: o.metadata.name },
      kind: KIND[resource],
      category,
      severity,
      rule,
      message,
    });

  // ---- Nodes
  for (const node of items("nodes")) {
    const ready = condition(node, "Ready");
    if (ready?.status !== "True")
      report("nodes", node, "Nodes", "error", "node-not-ready", `Not ready${ready?.message ? `: ${brief(ready.message)}` : ""}`);
    for (const type of NODE_PRESSURES)
      if (condition(node, type)?.status === "True")
        report("nodes", node, "Nodes", "warning", "node-pressure", `${type}: pods may be evicted`);
    if (condition(node, "NetworkUnavailable")?.status === "True")
      report("nodes", node, "Nodes", "error", "node-network", "Network unavailable");
    if (node.spec?.unschedulable) report("nodes", node, "Nodes", "info", "node-cordoned", "Cordoned: no new pod is scheduled on it");
  }

  // ---- Pods: what is broken right now
  for (const pod of items("pods")) {
    const phase: string | undefined = pod.status?.phase;
    if (phase === "Succeeded" || pod.metadata.deletionTimestamp) continue;
    if (phase === "Failed") {
      report(
        "pods",
        pod,
        "Pods",
        "error",
        "pod-failed",
        `Failed${pod.status?.reason ? ` (${pod.status.reason})` : ""}${pod.status?.message ? `: ${brief(pod.status.message)}` : ""}`,
      );
      continue;
    }
    const statuses: ContainerStatus[] = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    let broken = false;
    for (const s of statuses) {
      const waiting = s.state?.waiting;
      if (waiting?.reason && BROKEN_WAITING.has(waiting.reason)) {
        broken = true;
        const restarts = s.restartCount ? `, ${plural(s.restartCount, "restart")}` : "";
        report(
          "pods",
          pod,
          "Pods",
          "error",
          "container-broken",
          `Container ${s.name}: ${waiting.reason}${restarts}${waiting.message ? ` — ${brief(waiting.message, 100)}` : ""}`,
        );
      } else if ((s.restartCount ?? 0) >= RESTARTS_WARNING) {
        report("pods", pod, "Pods", "warning", "container-restarts", `Container ${s.name} restarted ${s.restartCount} times`);
      }
      if (s.lastState?.terminated?.reason === "OOMKilled")
        report(
          "pods",
          pod,
          "Pods",
          "warning",
          "container-oom",
          `Container ${s.name} was killed for lack of memory (OOMKilled): its memory limit is too low`,
        );
    }
    const scheduled = condition(pod, "PodScheduled");
    if (phase === "Pending" && scheduled?.status === "False") {
      report(
        "pods",
        pod,
        "Pods",
        "warning",
        "pod-unschedulable",
        `Cannot be scheduled: ${brief(scheduled.message) || scheduled.reason || "no node fits"}`,
      );
    } else if (!broken && phase === "Running") {
      const ready = condition(pod, "Ready");
      const since = ready?.lastTransitionTime ? now - Date.parse(ready.lastTransitionTime) : 0;
      if (ready?.status === "False" && since > NOT_READY_GRACE_MS)
        report("pods", pod, "Pods", "warning", "pod-not-ready", `Not ready for ${duration(since)}`);
    }
  }

  // ---- Workloads: their state, and the good practices of their pod template
  const replicas = (resource: string, o: KubeObject, ready: number, desired: number, what: string) => {
    if (desired > 0 && ready === 0) report(resource, o, "Workloads", "error", "workload-down", `No ${what} ready (0/${desired})`);
    else if (ready < desired) report(resource, o, "Workloads", "warning", "workload-degraded", `${ready}/${desired} ${what}s ready`);
  };
  for (const d of items("deployments")) {
    const progressing = condition(d, "Progressing");
    if (progressing?.status === "False" && progressing.reason === "ProgressDeadlineExceeded")
      report("deployments", d, "Workloads", "error", "rollout-stuck", "Rollout stuck: ProgressDeadlineExceeded");
    replicas("deployments", d, d.status?.readyReplicas ?? 0, d.spec?.replicas ?? 0, "replica");
  }
  for (const s of items("statefulsets")) replicas("statefulsets", s, s.status?.readyReplicas ?? 0, s.spec?.replicas ?? 0, "replica");
  for (const ds of items("daemonsets")) {
    replicas("daemonsets", ds, ds.status?.numberReady ?? 0, ds.status?.desiredNumberScheduled ?? 0, "pod");
    if (ds.status?.numberMisscheduled)
      report(
        "daemonsets",
        ds,
        "Workloads",
        "warning",
        "daemonset-misscheduled",
        `${plural(ds.status.numberMisscheduled, "pod")} on nodes where it should not run`,
      );
  }
  for (const job of items("jobs")) {
    const failed = condition(job, "Failed");
    if (failed?.status === "True")
      report(
        "jobs",
        job,
        "Workloads",
        "error",
        "job-failed",
        `Failed${failed.reason ? ` (${failed.reason})` : ""}${failed.message ? `: ${brief(failed.message)}` : ""}`,
      );
  }
  for (const cj of items("cronjobs"))
    if (cj.spec?.suspend) report("cronjobs", cj, "Workloads", "info", "cronjob-suspended", "Suspended: no job is created");

  const existing = {
    configmaps: names("configmaps"),
    secrets: names("secrets"),
    persistentvolumeclaims: names("persistentvolumeclaims"),
    serviceaccounts: names("serviceaccounts"),
  };
  /** Objects some pod or ingress uses. */
  const used: Partial<Record<Reference["resource"], Set<string>>> &
    Record<"configmaps" | "secrets" | "persistentvolumeclaims", Set<string>> = {
    configmaps: new Set(),
    secrets: new Set(),
    persistentvolumeclaims: new Set(),
  };
  // Pod templates: workloads, and pods of no controller. Pods of a controller are checked through it.
  for (const resource of ["deployments", "statefulsets", "daemonsets", "cronjobs", "jobs", "pods"]) {
    for (const o of items(resource)) {
      const spec = podSpec(resource, o);
      if (!spec) continue;
      const ns = o.metadata.namespace;
      const refs = references(spec);
      for (const r of refs) used[r.resource]?.add(key(ns, r.name));
      const owned = o.metadata.ownerReferences?.some((r) => r.controller);
      if (owned) continue;
      const category: Category = resource === "pods" ? "Pods" : "Workloads";
      for (const r of refs)
        if (!r.optional && existing[r.resource] && !existing[r.resource]!.has(key(ns, r.name)))
          report(resource, o, "Configuration", "error", "missing-reference", `Uses ${KIND[r.resource]} ${r.name}, which does not exist`);
      if (SYSTEM_NAMESPACE.test(ns ?? "")) continue;
      if (resource === "pods")
        report(
          "pods",
          o,
          "Pods",
          "info",
          "pod-unmanaged",
          "Not managed by a controller: it is not recreated if it dies or its node goes away",
        );
      const longRunning = resource !== "jobs" && resource !== "cronjobs";
      for (const c of spec.containers ?? []) {
        const requests = c.resources?.requests ?? {};
        const missing = ["cpu", "memory"].filter((r) => !requests[r]);
        if (missing.length)
          report(
            resource,
            o,
            category,
            "warning",
            "container-no-requests",
            `Container ${c.name} has no ${missing.join(" nor ")} request: the scheduler cannot place it reliably`,
          );
        if (floatingImage(c.image))
          report(
            resource,
            o,
            category,
            "warning",
            "image-floating",
            `Container ${c.name} runs ${c.image}: the version can change on any restart`,
          );
        // Less critical: one note per container.
        const lacks = [
          ...(c.resources?.limits?.memory ? [] : ["memory limit"]),
          ...(longRunning && !c.readinessProbe ? ["readiness probe (it receives traffic as soon as it starts)"] : []),
        ];
        if (lacks.length) report(resource, o, category, "info", "container-defaults", `Container ${c.name} has no ${lacks.join(" nor ")}`);
      }
    }
  }

  // ---- Network
  const pods = items("pods");
  for (const svc of items("services")) {
    const selector: Record<string, string> | undefined = svc.spec?.selector;
    if (svc.spec?.type === "ExternalName" || !selector || !Object.keys(selector).length || !lists.pods) continue;
    const selected = pods.filter((p) => p.metadata.namespace === svc.metadata.namespace && matches(selector, p.metadata.labels));
    const selectorText = Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    if (!selected.length) report("services", svc, "Network", "warning", "service-no-pods", `Selects no pod (${selectorText})`);
    else if (!selected.some((p) => condition(p, "Ready")?.status === "True"))
      report(
        "services",
        svc,
        "Network",
        "error",
        "service-no-ready-pods",
        `None of its ${plural(selected.length, "pod")} is ready: it has no endpoint`,
      );
    if (svc.spec?.type === "LoadBalancer" && !svc.status?.loadBalancer?.ingress?.length)
      report("services", svc, "Network", "warning", "loadbalancer-pending", "Its load balancer has no address yet");
  }
  const services = names("services");
  const servicesByKey = new Map(items("services").map((s) => [key(s.metadata.namespace, s.metadata.name), s]));
  for (const ing of items("ingresses")) {
    const ns = ing.metadata.namespace;
    const backends = [
      ing.spec?.defaultBackend,
      ...(ing.spec?.rules ?? []).flatMap((r: KubeObject) => (r.http?.paths ?? []).map((p: KubeObject) => p.backend)),
    ];
    for (const b of backends.filter((b) => b?.service?.name)) {
      const svc = servicesByKey.get(key(ns, b.service.name));
      if (services && !svc)
        report(
          "ingresses",
          ing,
          "Network",
          "error",
          "ingress-missing-service",
          `Routes to Service ${b.service.name}, which does not exist`,
        );
      const port = b.service.port;
      const ports: { name?: string; port: number }[] = svc?.spec?.ports ?? [];
      if (svc && port && !ports.some((p) => (port.name ? p.name === port.name : p.port === port.number)))
        report(
          "ingresses",
          ing,
          "Network",
          "warning",
          "ingress-missing-port",
          `Routes to port ${port.name ?? port.number} of Service ${b.service.name}, which it does not expose`,
        );
    }
    for (const tls of ing.spec?.tls ?? []) {
      if (tls.secretName) used.secrets.add(key(ns, tls.secretName));
      if (tls.secretName && existing.secrets && !existing.secrets.has(key(ns, tls.secretName)))
        report("ingresses", ing, "Network", "error", "ingress-missing-tls", `Uses TLS Secret ${tls.secretName}, which does not exist`);
    }
  }

  // ---- Configuration: ConfigMaps no pod uses (Secrets have too many indirect users: controllers, CRDs…)
  for (const cm of items("configmaps")) {
    const ns = cm.metadata.namespace ?? "";
    if (SYSTEM_NAMESPACE.test(ns) || cm.metadata.name === "kube-root-ca.crt" || cm.metadata.ownerReferences?.length || !lists.pods)
      continue;
    if (!used.configmaps.has(key(ns, cm.metadata.name)))
      report("configmaps", cm, "Configuration", "info", "configmap-unused", "Not used by any pod");
  }

  // ---- Storage
  for (const pvc of items("persistentvolumeclaims")) {
    const phase: string | undefined = pvc.status?.phase;
    if (phase === "Pending")
      report("persistentvolumeclaims", pvc, "Storage", "warning", "pvc-pending", "Pending: no volume is bound to it");
    else if (phase === "Lost") report("persistentvolumeclaims", pvc, "Storage", "error", "pvc-lost", "Lost: its volume no longer exists");
    else if (lists.pods && !used.persistentvolumeclaims.has(key(pvc.metadata.namespace, pvc.metadata.name)))
      report("persistentvolumeclaims", pvc, "Storage", "info", "pvc-unused", "Not used by any pod");
  }
  for (const pv of items("persistentvolumes")) {
    const phase: string | undefined = pv.status?.phase;
    if (phase === "Failed")
      report(
        "persistentvolumes",
        pv,
        "Storage",
        "error",
        "pv-failed",
        `Failed${pv.status?.message ? `: ${brief(pv.status.message)}` : ""}`,
      );
    else if (phase === "Released")
      report("persistentvolumes", pv, "Storage", "info", "pv-released", "Released: its claim was deleted, its data is kept");
  }

  // ---- Autoscaling and disruptions
  const workloads = { Deployment: names("deployments"), StatefulSet: names("statefulsets") } as Record<string, Set<string> | undefined>;
  for (const hpa of items("horizontalpodautoscalers")) {
    const target = hpa.spec?.scaleTargetRef;
    const known = target && workloads[target.kind];
    if (known && !known.has(key(hpa.metadata.namespace, target.name)))
      report(
        "horizontalpodautoscalers",
        hpa,
        "Autoscaling",
        "error",
        "hpa-missing-target",
        `Scales ${target.kind} ${target.name}, which does not exist`,
      );
    const active = condition(hpa, "ScalingActive");
    if (active?.status === "False")
      report(
        "horizontalpodautoscalers",
        hpa,
        "Autoscaling",
        "warning",
        "hpa-inactive",
        `Cannot scale: ${brief(active.message) || active.reason}`,
      );
    const max = hpa.spec?.maxReplicas;
    if (max && (hpa.status?.currentReplicas ?? 0) >= max)
      report(
        "horizontalpodautoscalers",
        hpa,
        "Autoscaling",
        "warning",
        "hpa-at-max",
        `At its maximum of ${max} replicas: it cannot scale further`,
      );
  }
  for (const pdb of items("poddisruptionbudgets")) {
    const s = pdb.status ?? {};
    if ((s.expectedPods ?? 0) > 0 && s.disruptionsAllowed === 0)
      report("poddisruptionbudgets", pdb, "Autoscaling", "warning", "pdb-blocking", "Allows no disruption: it blocks the drain of nodes");
  }

  const order: Severity[] = ["error", "warning", "info"];
  return problems.sort(
    (a, b) =>
      order.indexOf(a.severity) - order.indexOf(b.severity) ||
      (a.ref.namespace ?? "").localeCompare(b.ref.namespace ?? "") ||
      a.ref.name.localeCompare(b.ref.name),
  );
}

// ---------- The page ----------

const SEVERITY_TAG: Record<Severity, { text: string; tone: Tone }> = {
  error: { text: "Error", tone: "error" },
  warning: { text: "Warning", tone: "warning" },
  info: { text: "Info", tone: "info" },
};

const COLUMNS = [
  { id: "severity", title: "Severity", width: 96 },
  { id: "object", title: "Object", grow: 1.6 },
  { id: "namespace", title: "Namespace", grow: 0.8 },
  { id: "problem", title: "Problem", grow: 4 },
];

function problemRow(p: Problem, i: number): Row {
  const object = `${p.kind} ${p.ref.name}`;
  return {
    uid: `${p.ref.resource}/${key(p.ref.namespace, p.ref.name)}/${p.rule}/${i}`,
    ref: p.ref,
    cells: {
      severity: { tags: [SEVERITY_TAG[p.severity]], solid: true },
      object: { link: p.ref.name, ref: p.ref, prefix: `${p.kind} ` },
      namespace: p.ref.namespace ?? "",
      problem: p.message,
    },
    sort: { severity: ["error", "warning", "info"].indexOf(p.severity), object, namespace: p.ref.namespace ?? "", problem: p.message },
    search: `${object} ${p.ref.namespace ?? ""} ${p.message}`.toLowerCase(),
    actions: [],
  };
}

function counts(problems: Problem[]): Record<Severity, number> {
  return {
    error: problems.filter((p) => p.severity === "error").length,
    warning: problems.filter((p) => p.severity === "warning").length,
    info: problems.filter((p) => p.severity === "info").length,
  };
}

function summary(c: Record<Severity, number>): string {
  const parts = [c.error && plural(c.error, "error"), c.warning && plural(c.warning, "warning"), c.info && `${c.info} info`].filter(
    Boolean,
  );
  return parts.length ? parts.join(" · ") : "No problem";
}

function worstTag(c: Record<Severity, number>): { text: string; tone: Tone } {
  if (c.error) return { text: plural(c.error, "error"), tone: "error" };
  if (c.warning) return { text: plural(c.warning, "warning"), tone: "warning" };
  return { text: "OK", tone: "ok" };
}

/** The objects each category checks, for the cards. */
const SCANNED: Record<Category, string[]> = {
  Nodes: ["nodes"],
  Workloads: ["deployments", "statefulsets", "daemonsets", "jobs", "cronjobs"],
  Pods: ["pods"],
  Network: ["services", "ingresses"],
  Configuration: ["configmaps", "secrets", "serviceaccounts"],
  Storage: ["persistentvolumeclaims", "persistentvolumes"],
  Autoscaling: ["horizontalpodautoscalers", "poddisruptionbudgets"],
};

/** Problems computed once per input: the page and the Problems view share them. */
const cache = new WeakMap<OverviewInput, Problem[]>();

export function problemsOf(input: OverviewInput): Problem[] {
  let problems = cache.get(input);
  if (!problems) cache.set(input, (problems = diagnose(input)));
  return problems;
}

export const diagnosticsPage: OverviewPage = {
  id: "diagnostics",
  title: "Diagnostics",
  resources: RESOURCES,
  primary: "pods",
  // Their names are enough: no data of Secrets (Helm releases are large), nor of ConfigMaps (dashboards).
  metadataOnly: ["configmaps", "secrets"],
  problems: problemsOf,
  build(input): OverviewData {
    const problems = problemsOf(input);
    const scanned = RESOURCES.reduce((n, r) => n + (input.lists[r]?.length ?? 0), 0);
    // An object with an error or a warning is not healthy; info does not count.
    const unhealthy = new Set(
      problems.filter((p) => p.severity !== "info").map((p) => `${p.ref.resource}/${key(p.ref.namespace, p.ref.name)}`),
    ).size;
    const score = scanned ? Math.round((100 * (scanned - unhealthy)) / scanned) : 100;
    const all = counts(problems);
    const health: OverviewCard = {
      title: "Health",
      tag: { text: `${score}%`, tone: score >= 90 ? "ok" : score >= 70 ? "warning" : "error" },
      items: [
        { name: "Objects", value: `${scanned} checked, ${unhealthy} with problems` },
        { name: "Problems", value: summary(all) },
      ],
    };
    const cards = CATEGORIES.map((category): OverviewCard => {
      const c = counts(problems.filter((p) => p.category === category));
      const checked = SCANNED[category].reduce((n, r) => n + (input.lists[r]?.length ?? 0), 0);
      const unavailable = SCANNED[category].filter((r) => input.errors[r]);
      const items: DetailItem[] = [
        { name: "Problems", value: summary(c) },
        { name: "Checked", value: plural(checked, "object") },
      ];
      if (unavailable.length)
        items.push({
          name: "Unavailable",
          value: {
            text: unavailable.map((r) => KIND[r]).join(", "),
            tone: "warning",
            title: unavailable.map((r) => input.errors[r]).join("\n"),
          },
        });
      return { title: category, tag: worstTag(c), items };
    });
    const tables = CATEGORIES.flatMap((category): OverviewTable[] => {
      const rows = problems.filter((p) => p.category === category).map(problemRow);
      if (!rows.length) return [];
      const c = counts(problems.filter((p) => p.category === category));
      return [{ title: category, icon: c.error ? "error" : c.warning ? "warning" : "info", columns: COLUMNS, rows, empty: "No problem" }];
    });
    return { cards: [health, ...cards], donuts: [], tables };
  },
};
