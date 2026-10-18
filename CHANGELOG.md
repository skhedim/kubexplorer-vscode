# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
