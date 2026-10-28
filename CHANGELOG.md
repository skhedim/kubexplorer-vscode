# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-28

### Added

- Usage charts over time (CPU, memory, network, filesystem) in the details of pods, workloads and nodes, with
  requests, limits and allocatable capacity. Prometheus is detected and queried through the API server proxy
  (setting `kubexplorer.prometheus`); without it, the charts use metrics-server samples.
- Flux: lists and details of every Flux kind (Flux Operator, Kustomize, Helm, sources, image automation,
  notifications), Reconcile / Suspend / Resume actions and a Flux overview.
- Karpenter: NodePools, NodeClaims, EC2 / AKS / KWOK NodeClasses, a Karpenter dashboard and a Karpenter section in
  the details of the nodes it manages.
- The Flux and Karpenter menus show up only when their CRDs are installed.
- `dev-cluster/setup.sh --addons` installs Flux, a simulated Karpenter (kwok) and Prometheus on the development
  cluster.
- Protected contexts (`kubexplorer.protectedContexts`, `*prod*` by default): framed in red in the tabs, the status
  bar and the Clusters view; every change asks to type the name of its target, or is refused in `readOnly` mode
  (`kubexplorer.protectedContextsMode`).
- Saving a YAML document (Ctrl+S, or **Apply to Cluster** in the editor title) opens the diff against the object on
  the cluster, under a dialog to apply or cancel.
- **Fleet**: many clusters at once. The Clusters view groups the contexts (`kubexplorer.fleet.groups`, prod and
  dev by default); the Fleet tab shows each cluster, compares the Flux objects across the clusters of a group to find
  drifts (revisions, chart versions, missing, suspended, behind their source), reconciles, suspends or resumes them
  on several clusters, aggregates the diagnostics and searches the clusters.
- **Diagnostics**, like Popeye: rules that report broken objects, risky configurations and things worth a look,
  with a health score, also published in the Problems view of VS Code.
- Secret values can be edited in place in the details drawer.
- Logs of workloads (Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs): every pod at once, one color per
  pod.
- **Edit Decoded Values** on Secrets: values in clear under `stringData`.
- **Debug...** on pods: an ephemeral debug container (`kubectl debug`) attached to a terminal (`kubexplorer.debug.image`).
- Bulk actions on the checked rows: restart, scale, reconcile, suspend, resume, cordon, uncordon, drain and delete.
- The events of an object at the end of every drawer (they were shown for Flux and Karpenter objects only).
- **Managed By**: the drawer of an object applied by Flux links to its Kustomization or HelmRelease; scaling,
  deleting, applying the YAML of or editing a Secret value of such an object warns that Flux will undo the change,
  and offers to suspend that Kustomization or HelmRelease first.
- Nodes: **Cordon**, **Uncordon**, **Drain** (in a terminal) and **Node Shell** (a root shell from a privileged pod
  in the namespaces of the node, deleted on exit).
- CronJobs: **Suspend** and **Resume**.
- Fleet: **Export** opens a Markdown report of the clusters shown (clusters, failing and drifting Flux objects,
  diagnostics, unreachable clusters).
- Fleet: a drift a rollout explains (another revision, missing, behind its source) shows as **Rolling out** until it
  lasts `kubexplorer.fleet.driftGrace` minutes (10 by default).

### Changed

- The Workloads menu has no Overview entry any more: it opened the Cluster page.
- The lists and watches of a cluster go through a single `kubectl proxy` (over a private Unix socket, read-only)
  instead of a kubectl process per list and per request: the Diagnostics page of the development cluster runs 1
  kubectl process instead of 16 (40 MB instead of 690 MB) and loads in 1 s instead of 4. A watch ended by the
  server goes on from where it stopped instead of listing everything again, and the 5-minute full resync is gone.
  A cluster whose proxy cannot start falls back to kubectl processes.
- Large lists are virtual: only the rows in view are in the page. 5,000 pods render in 0.1 s instead of 5 s; a
  changed pod updates the list in 11 ms (1 KB sent) instead of 0.6 s (6 MB).
- Only the rows that changed are rebuilt and sent to a tab; ages are computed by the webview, so rows no longer
  change every 30 seconds.
- The details drawer is refreshed when the object it shows changes (and every 30 seconds for the related objects),
  no longer at every change of the list; it reads the object from the lists of the tab when it can.
- A list stays followed 30 seconds after its tab is hidden or closed: showing it again is instant.
- The Diagnostics page reads the metadata only of Secrets and ConfigMaps.
- `kubexplorer.protectedContexts`, `kubexplorer.protectedContextsMode` and `kubexplorer.confirmApply` are user (or
  remote) settings: the settings of a workspace can no longer turn off the protection of production contexts.
- Metrics are polled at most every 15 seconds (the resolution of metrics-server), Helm lists at most every minute.
- Large lists sort about 20 times faster.

### Fixed

- Helm 4: the list of Helm releases failed (`helm list` no longer knows `--all`, it lists every release by default).
- Fleet: an object on 1 cluster of a group was reported missing on all the others; it is now expected on the whole
  group only when at least half of the group has it.
- Auto save (`files.autoSave`) applied YAML documents to the cluster, half-typed, or asked for a review at every
  pause: only an explicit save applies now (Ctrl+S, File > Save).
- Fleet: a single unreachable cluster made the fleet look never scanned: no "scanned … ago", and a full scan every
  time the tab was shown again.
- Fleet: the Flux column showed the version of kustomize-controller (v1.x) as if it were the version of Flux: the
  controller is now named ("kustomize v1.9.6").
- Fleet: a cluster without Flux cost a request per Flux kind at every scan; the kinds a cluster does not serve are now
  remembered for 10 minutes (the refresh button asks again).
- The details drawer no longer blinks when its content refreshes.
- Reopening the YAML of an object changed on the cluster since its tab was closed showed the previous version.
- A Flux or Karpenter overview tab restored after a restart showed the cluster overview.

## [0.1.0] - 2026-10-18

### Added

- Clusters view (kubeconfig contexts) and Resources view (the Freelens side menu, with Custom Resources).
- Resource tabs for every built-in kind and every CRD: sortable and searchable lists, details drawer, links
  between objects, multi-namespace filter, bulk deletion, reuse of the current tab.
- Live updates with `kubectl get --watch`, with polling as a fallback.
- Cluster overview: usage against requests and allocatable capacity, workload statuses, warning events.
- metrics-server metrics for pods and nodes.
- Logs and shells in the VS Code terminal.
- YAML editing applied on save, and `kubectl describe` documents.
- Secret values revealed on demand.
- Helm charts (values, install) and releases (values, manifest, notes, history, rollback, uninstall).
- Port forwarding from pods and services.
- Workspace Trust support, localizable strings, VS Code and Freelens appearances.

[Unreleased]: https://github.com/skhedim/kubexplorer-vscode/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/skhedim/kubexplorer-vscode/releases/tag/v0.2.0
[0.1.0]: https://github.com/skhedim/kubexplorer-vscode/tree/92648a6
