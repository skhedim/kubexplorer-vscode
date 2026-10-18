// Captures real `kubectl get -o json` output into test/fixtures, for the unit tests.
//   npm run fixtures [-- <context>]      (default: kind-kubexplorer, created by dev-cluster/setup.sh)
// Refuses any context that is not a local kind cluster: shared clusters are never captured.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const context = process.argv[2] ?? "kind-kubexplorer";
if (!context.startsWith("kind-")) {
  console.error(`Refusing ${context}: only local kind clusters can be captured.`);
  process.exit(1);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(out, { recursive: true });

/** kubectl resource -> fixture file name. */
const KINDS = {
  pods: "pods",
  deployments: "deployments",
  statefulsets: "statefulsets",
  daemonsets: "daemonsets",
  replicasets: "replicasets",
  jobs: "jobs",
  cronjobs: "cronjobs",
  nodes: "nodes",
  namespaces: "namespaces",
  events: "events",
  services: "services",
  configmaps: "configmaps",
  secrets: "secrets",
  "ingresses.networking.k8s.io": "ingresses",
  persistentvolumeclaims: "persistentvolumeclaims",
  persistentvolumes: "persistentvolumes",
  "storageclasses.storage.k8s.io": "storageclasses",
  "pods.metrics.k8s.io": "podmetrics",
  "nodes.metrics.k8s.io": "nodemetrics",
};

/** Kinds of the add-ons (dev-cluster/setup.sh --addons): skipped when their CRD is missing. */
const ADDON_KINDS = {
  "kustomizations.kustomize.toolkit.fluxcd.io": "flux-kustomizations",
  "helmreleases.helm.toolkit.fluxcd.io": "flux-helmreleases",
  "gitrepositories.source.toolkit.fluxcd.io": "flux-gitrepositories",
  "ocirepositories.source.toolkit.fluxcd.io": "flux-ocirepositories",
  "helmrepositories.source.toolkit.fluxcd.io": "flux-helmrepositories",
  "helmcharts.source.toolkit.fluxcd.io": "flux-helmcharts",
  "buckets.source.toolkit.fluxcd.io": "flux-buckets",
  "imagerepositories.image.toolkit.fluxcd.io": "flux-imagerepositories",
  "imagepolicies.image.toolkit.fluxcd.io": "flux-imagepolicies",
  "alerts.notification.toolkit.fluxcd.io": "flux-alerts",
  "providers.notification.toolkit.fluxcd.io": "flux-providers",
  "receivers.notification.toolkit.fluxcd.io": "flux-receivers",
  "nodepools.karpenter.sh": "karpenter-nodepools",
  "nodeclaims.karpenter.sh": "karpenter-nodeclaims",
  "ec2nodeclasses.karpenter.k8s.aws": "karpenter-ec2nodeclasses",
};

const write = (file, data) => writeFileSync(join(out, `${file}.json`), `${JSON.stringify(data, null, 1)}\n`);

const eventTime = (e) => e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? "";

const list = (kind) =>
  JSON.parse(
    execFileSync("kubectl", ["--context", context, "get", kind, "-A", "-o", "json"], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString(),
  ).items;

for (const [kind, file] of [...Object.entries(KINDS), ...Object.entries(ADDON_KINDS)]) {
  let items;
  try {
    items = list(kind);
  } catch (err) {
    if (!(kind in ADDON_KINDS)) throw err;
    console.log(`${file.padEnd(24)} skipped: run dev-cluster/setup.sh --addons`);
    continue;
  }
  for (const item of items) {
    delete item.metadata.managedFields;
    // This annotation copies the applied manifest, including the stringData of Secrets.
    delete item.metadata.annotations?.["kubectl.kubernetes.io/last-applied-configuration"];
    // Secret values never land in the repository, not even fake ones.
    if (item.kind === "Secret" && item.data) item.data = Object.fromEntries(Object.keys(item.data).map((k) => [k, "UkVEQUNURUQ="]));
  }
  // The most recent events are enough, and keep the fixture small.
  if (file === "events") items = items.sort((a, b) => eventTime(b).localeCompare(eventTime(a))).slice(0, 150);
  write(file, items);
  console.log(`${file.padEnd(24)} ${items.length} objects`);
}

// Helm releases, as printed by `helm list -o json`.
const releases = JSON.parse(
  execFileSync("helm", ["list", "--kube-context", context, "--all-namespaces", "--all", "-o", "json"]).toString(),
);
write("helm-releases", releases);
console.log(`${"helm-releases".padEnd(24)} ${releases.length} releases`);
