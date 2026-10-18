# Contributing to KubeXplorer

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Before you start

- Search the [issues](https://github.com/skhedim/kubexplorer-vscode/issues) first; open one to discuss larger
  changes before working on them.
- Read [docs/architecture.md](docs/architecture.md): it explains the layers of the code and how to add a resource
  type or an action.
- Be kind: this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Prerequisites: Node.js 24 (see `.nvmrc`), `kubectl`, and for the local cluster `docker`, `kind` and `helm`.

```sh
git clone https://github.com/skhedim/kubexplorer-vscode.git
cd kubexplorer-vscode
npm ci
npm run build
```

Press `F5` in VS Code to start an Extension Development Host. The **Run Extension (dev cluster only)** launch
configuration restricts it to the local cluster below.

### Local cluster

`dev-cluster/setup.sh` creates a three-node [kind](https://kind.sigs.k8s.io/) cluster named `kubexplorer`, deploys
sample workloads in every state the UI renders (healthy, CrashLoopBackOff, Pending, completed Jobs…), metrics-server
and a Helm release, then writes `test/.kubeconfig-kind`, a kubeconfig holding only this cluster.

```sh
./dev-cluster/setup.sh                 # idempotent: run it again to restore the sample workloads
./dev-cluster/setup.sh --addons        # also Flux, Karpenter (simulated by kwok) and Prometheus
kind delete cluster --name kubexplorer # when you are done
```

The add-ons (`dev-cluster/addons/`) give the Flux, Karpenter and chart views real data: Flux reconciles podinfo
from GitHub (with a broken and a suspended Kustomization), kwok simulates the nodes of two Karpenter NodePools
(there is no Karpenter controller: `addons/karpenter/apply.sh` writes the statuses and events), and Prometheus
scrapes cAdvisor. Run `./dev-cluster/addons/karpenter/apply.sh` again to refresh its events, which expire after an
hour.

Integration tests and screenshot scripts only ever use `test/.kubeconfig-kind`: they cannot reach your other
clusters.

## Scripts

| Command                               | Purpose                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run watch`                       | Rebuild on change (used by `F5`).                                                |
| `npm run check`                       | Type-check, lint, format check, dead code check (knip) and unit tests.           |
| `npm test`                            | Unit tests (Vitest), on fixtures captured from a real cluster.                   |
| `npm run test:integration`            | Integration tests in a real VS Code, against the local cluster.                  |
| `npm run preview`                     | The webview and its controller on the demo cluster, at `http://localhost:5178/`. |
| `npm run screenshots`                 | Screenshots of the preview (`screenshots/`).                                     |
| `node scripts/vscode-screenshots.mjs` | README screenshots in a real VS Code (`docs/images/`).                           |
| `npm run fixtures`                    | Capture the test fixtures again from the local cluster.                          |
| `npm run l10n:export`                 | Update `l10n/bundle.l10n.json` with the strings of the code.                     |
| `npm run package`                     | Build `dist/kubexplorer.vsix`.                                                   |

## Guidelines

- **Layers**: only `src/vscode/` and `src/extension.ts` may import `vscode`; `src/resources`, `src/panel`,
  `src/shared` and `src/webview` must not use Node.js modules. ESLint enforces both.
- **Strings**: user-facing text of the extension host goes through `vscode.l10n.t()`; strings of `package.json` live
  in `package.nls.json` (a unit test checks that both match).
- **Tests**: add unit tests next to the code you change (`test/unit/` mirrors `src/`). A new resource type gets a
  fixture (`npm run fixtures`) and is then covered by `test/unit/resources/registry.test.ts`.
- **Safety**: every kubectl and helm call passes the context explicitly; destructive actions ask for confirmation
  and name the context.
- **Style**: Prettier formats everything (`npm run format`); keep comments for the _why_.

## Pull requests

1. Create a branch from `main`.
2. Run `npm run check` (and `npm run test:integration` when you touch `src/vscode` or kubectl calls).
3. Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
4. Open the pull request and fill in the template. CI runs the checks on Linux, macOS and Windows, plus the
   integration tests against a kind cluster.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`…).

## Releasing (maintainers)

1. Move the **Unreleased** entries of `CHANGELOG.md` under a new version and bump `version` in `package.json`.
2. Commit, tag `vX.Y.Z` and push the tag.
3. The **Release** workflow checks the tag against `package.json`, packages the extension, creates the GitHub
   release, and publishes to the VS Code Marketplace and Open VSX when the `VSCE_PAT` and `OVSX_PAT` secrets are set.
