# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Bulk actions on the checked rows: restart, scale, reconcile, suspend, resume and delete.

### Changed

- `kubexplorer.protectedContexts`, `kubexplorer.protectedContextsMode` and `kubexplorer.confirmApply` are user (or
  remote) settings: the settings of a workspace can no longer turn off the protection of production contexts.
- Metrics are polled at most every 15 seconds (the resolution of metrics-server), Helm lists at most every minute.
- Large lists sort about 20 times faster.

### Fixed

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

[Unreleased]: https://github.com/skhedim/kubexplorer-vscode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/skhedim/kubexplorer-vscode/releases/tag/v0.1.0
