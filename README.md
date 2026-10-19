# KubeXplorer

[![CI](https://github.com/skhedim/kubexplorer-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/skhedim/kubexplorer-vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A Kubernetes explorer built into VS Code, inspired by [Freelens](https://github.com/freelensapp/freelens).**
Browse your clusters from the side bar, read every resource in an editor tab, follow logs and open shells in the
terminal, follow usage charts, edit YAML and apply it on save, manage Helm releases, Flux and Karpenter, all without
leaving the editor.

![Cluster overview](docs/images/overview.png)

## Features

- **Clusters view**: every context of your kubeconfig, with a colored avatar like the Freelens hotbar.
- **Resources view**: the Freelens side menu (Workloads, Config, Network, Storage, Namespaces, Events, Helm,
  Access Control) and your Custom Resources, discovered on the cluster. The Flux and Karpenter sections show up
  when their CRDs are installed.
- **Resource tabs**: sortable, searchable lists with live updates (`kubectl get --watch`), a resizable details
  drawer with links between objects, multi-namespace filtering, and bulk actions on the checked rows (restart,
  scale, reconcile, suspend, resume, delete). Opening another resource type
  reuses the current tab; **Open in New Tab** keeps one.
- **Cluster overview**: CPU and memory usage against requests and allocatable capacity, workload status charts and
  the latest warning events.
- **Usage charts**: CPU, memory, network and filesystem over the last hour at the top of the details of pods,
  workloads and nodes, with requests, limits and allocatable capacity, like the Freelens metric tabs. KubeXplorer
  finds Prometheus on the cluster and queries it through the API server (no port forward); without Prometheus, the
  charts use metrics-server samples collected while VS Code runs. Lists show metrics-server CPU and memory columns
  and node gauges.
- **Flux**, following the [Freelens Flux extension](https://github.com/freelensapp/freelens-extension-fluxcd):
  Kustomizations, Helm releases, sources, image automation, notifications and Flux Operator objects, with their
  status, source links, inventory, release history, conditions and events; **Reconcile**, **Suspend** and
  **Resume** actions; an overview with a status chart per kind and the Flux events.
- **Karpenter**, following the [Freelens Karpenter extension](https://github.com/freelensapp/freelens-extension-karpenter):
  NodePools against their limits, NodeClaims, EC2, AKS and KWOK NodeClasses, a dashboard (NodePool cards, claims by
  status, nodes by capacity type, zone and instance type, scaling decisions) and a Karpenter section in the details
  of the nodes it manages.
- **Logs and shells** in the VS Code terminal: colored log levels, all containers or one, previous container,
  `kubectl exec` with bash or sh. The logs of a Deployment, StatefulSet, DaemonSet, ReplicaSet or Job follow all
  its pods at once, each pod in its own color, like `stern`.
- **Debug containers**: **Debug...** adds an ephemeral container (`kubectl debug`, busybox, netshoot or any image)
  sharing the processes of a container, and attaches it to a terminal: for distroless images without a shell.
- **YAML as a document**: edit any object in a real editor tab. **Ctrl+S** (or **Apply to Cluster** in the editor
  title) opens the diff against the object on the cluster, under a dialog to apply it (`kubectl replace`) or cancel.
  Conflicts surface as regular save errors.
- **Secrets**: values stay hidden; the eye button reveals one value at a time, on demand, and the pencil edits it in
  place (Ctrl+Enter saves). **Edit Decoded Values** opens the whole Secret with its values in clear, under
  `stringData`: no base64 to encode or decode.
- **Protected contexts**: the contexts matching `kubexplorer.protectedContexts` (`*prod*` by default) are framed in
  red, and every change asks you to type the name of its target; in `readOnly` mode, changes are refused.
- **Helm**: charts of your repositories (values, install) and releases (values, manifest, notes, history, rollback,
  uninstall).
- **Port forwarding** from pods and services, with a link to open the forwarded port in your browser, even in
  WSL or remote sessions.
- **Native VS Code UI**: context menus, quick picks, modal confirmations, status bar items, theme colors and
  keyboard navigation. The `freelens` appearance brings back the original Freelens palette.

| Workloads and details                     | Logs in the terminal, native context menu                       |
| ----------------------------------------- | --------------------------------------------------------------- |
| ![Pods and details](docs/images/pods.png) | ![Logs and context menu](docs/images/logs-and-context-menu.png) |
| **Secrets, revealed on demand**           | **Helm releases**                                               |
| ![Secrets](docs/images/secrets.png)       | ![Helm releases](docs/images/helm.png)                          |
| **Flux overview**                         | **Flux Kustomization, with its inventory**                      |
| ![Flux](docs/images/flux-overview.png)    | ![Flux Kustomization](docs/images/flux-kustomizations.png)      |
| **Karpenter dashboard**                   | **Karpenter NodePool**                                          |
| ![Karpenter](docs/images/karpenter.png)   | ![Karpenter NodePool](docs/images/karpenter-nodepool.png)       |

## Requirements

- VS Code 1.90 or later.
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/) on your `PATH` (or set `kubexplorer.kubectlPath`), and a
  kubeconfig. KubeXplorer uses kubectl for everything, so every authentication plugin kubectl supports works.
- Optional: [`helm`](https://helm.sh/docs/intro/install/) for the Helm views,
  [metrics-server](https://github.com/kubernetes-sigs/metrics-server) on the cluster for CPU and memory figures,
  and Prometheus (kube-prometheus-stack, the prometheus chart or any Prometheus scraping cAdvisor) for an hour of
  usage history and the network and filesystem charts.

## Getting started

1. Open the **KubeXplorer** view in the activity bar.
2. Pick a cluster in **Clusters** (the current context of your kubeconfig is selected by default).
3. Open a resource type in **Resources**. Click a row for its details; right-click it, or use `⋮`, for actions.

In a resource tab: `Ctrl+F` or `/` searches, `↑`/`↓` move the selection while the drawer is open, `Escape`
closes the drawer.

Without a cluster at hand, run **KubeXplorer: Show/Hide Demo Cluster** to explore a fictitious, offline cluster.

## Settings

| Setting                             | Default        | Description                                                                                                    |
| ----------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `kubexplorer.kubectlPath`           | `kubectl`      | Path to kubectl.                                                                                               |
| `kubexplorer.helmPath`              | `helm`         | Path to helm.                                                                                                  |
| `kubexplorer.watch`                 | `true`         | Follow lists in real time. When disabled, lists are polled.                                                    |
| `kubexplorer.pollInterval`          | `5`            | Polling interval (seconds) for lists that cannot be watched.                                                   |
| `kubexplorer.reuseTab`              | `true`         | Reuse the current tab when opening another resource type.                                                      |
| `kubexplorer.appearance`            | `vscode`       | `vscode` follows your color theme; `freelens` uses the Freelens dark palette.                                  |
| `kubexplorer.confirmApply`          | `true`         | Ask before applying a saved YAML document.                                                                     |
| `kubexplorer.protectedContexts`     | `["*prod*"]`   | Contexts to protect (patterns, `*` matches any text): framed in red, changes confirmed by typing a name.       |
| `kubexplorer.protectedContextsMode` | `confirm`      | `confirm`: type the name of the target of each change; `readOnly`: no change at all, no shell.                 |
| `kubexplorer.logs.tailLines`        | `500`          | Past log lines shown when opening logs.                                                                        |
| `kubexplorer.debug.image`           | `busybox:1.37` | Default image of the ephemeral containers of **Debug...**.                                                     |
| `kubexplorer.prometheus`            | (empty)        | Prometheus of the usage charts, as `namespace/service:port`; empty detects it; `off` uses metrics-server only. |
| `kubexplorer.demoCluster`           | `false`        | Add an offline demo cluster to the Clusters view.                                                              |

The **Output › KubeXplorer** channel logs every kubectl and helm command (set its level with **Developer: Set Log
Level...**).

## Security and privacy

- KubeXplorer never changes the current context of your kubeconfig: every command passes `--context` explicitly.
- Destructive actions (delete, scale to zero, restart, rollback, uninstall, apply) ask for confirmation and name
  the target context. On protected contexts (`kubexplorer.protectedContexts`), every change asks you to type the
  name of its target, or is refused in `readOnly` mode.
- Secret values are never sent to the UI, except the one you reveal, and are never stored.
- In untrusted workspaces, `kubexplorer.kubectlPath` and `kubexplorer.helmPath` are ignored if set by the
  workspace, so opening a repository cannot make KubeXplorer run an arbitrary binary.
- No telemetry.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup (including a local
kind cluster), and [docs/architecture.md](docs/architecture.md) for how the code is organized.

## Acknowledgements

The layout, colors and status rules of the resource tabs come from [Freelens](https://github.com/freelensapp/freelens),
the open source Kubernetes IDE (MIT), and the Flux and Karpenter views from its Flux and Karpenter extensions.
KubeXplorer is an independent project.

## License

[MIT](LICENSE)
