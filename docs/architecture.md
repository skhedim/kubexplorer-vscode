# Architecture

KubeXplorer is split into layers. Only `src/vscode/` and `src/extension.ts` use the VS Code API; everything else is
plain TypeScript, unit tested with Vitest, and partly bundled into the browser preview. ESLint enforces the
boundaries.

```text
src/
  extension.ts        Entry point: wires the layers and registers the commands.
  kube/               Cluster access.
    client.ts           KubeClient interface (list, inform, watch, YAML, logs, exec…).
    kubectl.ts          kubectl implementation; every call passes --context. Lists, watches and raw GETs go through
                        the kubectl proxy of the cluster (api.ts) when it can start, kubectl processes otherwise.
    proxy.ts            One `kubectl proxy` per cluster, private (Unix socket, or 127.0.0.1 and a secret prefix) and
                        read-only, started on first use and stopped when idle; the HTTP transport.
    api.ts              Lists page by page, watches from a resourceVersion and raw GETs over that transport; the
                        path of a kind from its kubectl name and the preferred version of its group.
    informer.ts         List, then watch from its resourceVersion; go on after the server ends a watch, list again
                        when the resourceVersion expired.
    demo.ts             In-memory demo cluster producing real `kubectl -o json` shaped objects.
    routing.ts          Routes to kubectl or the demo, and serves virtual lists.
    store.ts            Shared list cache, kept 30 s after its last subscriber: an informer, else watch + list, else
                        polling.
    helm.ts             Helm client (CLI and demo); releases and charts as Kubernetes-shaped objects.
    crds.ts             Installed CRDs per cluster (cached): optional kinds are shown only when installed.
    prometheus.ts       Prometheus detection and range queries through the API server proxy; demo metrics.
    portForward.ts      kubectl port-forward processes.
    secretYaml.ts       The YAML of a Secret with its text values decoded under stringData.
    jsonStream.ts       Splits the JSON stream of kubectl --watch.
    quantity.ts         Kubernetes quantities (CPU, memory).
    models.ts           Shapes of the Kubernetes sub-objects the descriptors read.
    virtualKinds.ts     Identifiers of the virtual lists.
  resources/          Kubernetes knowledge, declarative.
    descriptor.ts       defineResource(): columns, details and actions of a kind.
    pods.ts, workloads.ts, cluster.ts, config.ts, network.ts, storage.ts, access.ts, crd.ts, helm.ts,
    portForwards.ts, metrics.ts
    flux/               Flux kinds (optional): their state (status.ts), what they share (kind.ts: links, columns,
                        conditions, inventory, patch actions), the kinds by family, and the Flux overview page.
    fluxOwner.ts        The Kustomization or HelmRelease that applies an object, from its labels.
    karpenter.ts        Karpenter kinds (optional) and the Karpenter section of nodes.
    karpenterOverview.ts  The Karpenter dashboard.
    charts.ts           PromQL queries of a pod, workload or node, and the usage charts built from them.
    registry.ts         Built-in kinds, CRDs registered at runtime, and the overview pages.
    menu.ts             The Freelens side menu (with the Flux and Karpenter menus), shown by the Resources view.
    overview.ts         Overview pages; the cluster one: usage, status donuts and warning events.
    diagnostics.ts      Diagnostics rules (Popeye-like) and their overview page.
    fleet.ts            Fleet groups, compact summaries of a cluster, the Flux matrix and its drifts, search kinds.
    fleetViews.ts       The tabs and details of the Fleet tab, as overview data.
    fleetReport.ts      The Markdown report of the Fleet tab, from the same tables.
    format.ts           Ages (computed by the webview), cells and the metadata block shared by every drawer.
  panel/
    controller.ts       Logic of one tab: subscriptions while visible, rows (the full list, then patches), details
                        (rebuilt when their object changes), charts, secret reveal.
    metrics.ts          Usage charts: Prometheus, or the metrics-server samples collected in memory.
    fleetScanner.ts     Reads the clusters of the fleet (one request each, bounded concurrency), diagnostics, search.
    fleetController.ts  Logic of the Fleet tab.
  shared/             Contracts shared by the extension host and the webview.
    view.ts             Generic view model: columns, typed cells, detail sections.
    protocol.ts         HostMessage / WebviewMessage, persisted webview state.
    protection.ts       Protected contexts: pattern matching, actions refused on read-only contexts.
    diff.ts             Line diff of a YAML document against the cluster, summarized for the apply confirmation.
    logFormat.ts, encoding.ts, clusterNames.ts
  webview/            UI of the tabs: framework-free HTML rendering by regions (app.ts, render.ts), the virtual main
                      list (rows.ts), the header (header.ts), Secret values (secrets.ts), SVG charts (chart.ts).
  vscode/             VS Code integration.
    clustersView.ts, resourcesView.ts   Tree views.
    panels.ts           Webview panels: tab reuse, serializer for restoring tabs after a restart.
    actions.ts          Actions with native dialogs, input boxes and quick picks: dispatch, changes, bulk actions;
                        sessionActions.ts (logs, shells, port forwards, node shells, drains), helmActions.ts.
    fluxGuard.ts        The warning before a change Flux would undo, with the offer to suspend its Flux object.
    terminals.ts        Logs (Pseudoterminal) of a pod or a workload, shells (kubectl exec), debug containers, node
                        shells and drains.
    documents.ts        kubexplorer:/ file system (save = diff, confirmation, kubectl replace; decoded Secrets),
                        describe and read-only documents.
    fleetActions.ts     Flux actions on several clusters: pick, confirm, run with progress.
    problems.ts         The Problems view: the problems of a Diagnostics tab, on the YAML document of each object.
    protection.ts       ContextGuard: confirmations by typed name on protected contexts, refusals on read-only ones.
    clusterState.ts     Active cluster and namespaces per context (persisted).
    statusBar.ts, config.ts, logger.ts
```

## Data flow

1. The Resources view runs `kubexplorer.openResource("pods")`.
2. `ResourcePanels` reuses the current tab (or creates one) and gives it a `PanelController`.
3. Once the tab is visible and its webview has sent `ready`, the controller subscribes to the `ResourceStore`.
4. On every update, the controller turns the objects that changed into rows (`descriptor.toRow`) and posts them: the
   full list first, then patches (`rowsPatch`).
5. The webview sorts and filters locally, renders the rows in view only, and sends intents back (`showDetails`,
   `action`, `revealSecret`…).
6. Actions go through `ResourceActions` (native UI), then `store.refresh()` updates the lists.

A hidden tab unsubscribes: a cluster is only queried for what is on screen. Its lists stay followed 30 seconds,
so that showing it again is instant.

## Real time

Every list of a cluster goes through its `kubectl proxy`: an informer lists it (500 objects per page, like kubectl),
then watches from the `resourceVersion` of the list. A watch ended by the server (after 5 to 10 minutes) goes on from
its last `resourceVersion` (bookmarks keep it current); only an expired one (410) lists again. Errors are retried
with a growing delay. Kinds that cannot be watched (metrics.k8s.io: their lists have no `resourceVersion`) are
polled. Event bursts are coalesced (100 ms). Objects without `uid` (metrics) are keyed by namespace and name.

When the proxy of a cluster cannot start, its lists fall back to kubectl processes: the store starts
`kubectl get --watch-only --output-watch-events` **then** runs a full list (events received while listing are
merged, the highest `resourceVersion` wins), with a full resync every 5 minutes.

## Related and virtual lists

- A descriptor can declare **related** lists: the controller subscribes to them and passes them to the row
  rendering (`RowContext`). Pods show their metrics this way (`podmetrics`).
- A **virtual** list is not served by `kubectl get` (Helm releases and charts, port forwards): `RoutingClient`
  delegates it to a `VirtualSource` returning Kubernetes-shaped objects, so lists, details, the store and actions
  work unchanged.

## Usage charts

Descriptors that have charts declare a `metrics` scope: the pod itself, the pods of a workload, or a node.
The drawer gets a `metrics` placeholder section, and the controller loads the charts separately, after the
details, then every 20 seconds while the object stays shown (a `metrics` message):

1. `charts.ts` turns the scope into PromQL queries (cAdvisor series, summed over the containers).
2. `PrometheusClient` runs them as range queries through the API server service proxy
   (`kubectl get --raw /api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/api/v1/query_range`). The service is
   detected among the services of the cluster, or set by `kubexplorer.prometheus`.
3. Without Prometheus, `MetricsHistory` provides the metrics-server samples recorded from every metrics list the
   tabs receive, for the last hour.

Requests, limits and allocatable capacity are reference lines computed from the pod specs and the node.

## Integrations (Flux, Karpenter)

Their descriptors are built-in, but `optional`: the Resources view shows their menu entries only when
`CrdCatalog` finds their CRD, and an overview page skips them otherwise. A CRD with a dedicated descriptor opens
it from the Custom Resources section too. Their actions (Reconcile, Suspend, Resume) are merge patches declared by
the descriptor (`patches`), so `actions.ts` applies them without knowing Flux.

## Secrets

Descriptors never put Secret values in the view model: data items carry a `secretKey`. The eye button asks the
controller for one key; the controller reads the Secret again, decodes that value and sends it to the webview only.
Revealed values live in the webview memory and are dropped when the drawer shows another object.

## Adding a resource type

1. Describe it with `defineResource()` in the file of its category (columns, detail rows, sections).
2. Add it to `BUILT_IN` in `registry.ts` and to `MENU` in `menu.ts`.
3. Add it to `scripts/capture-fixtures.mjs`, run `npm run fixtures`, and list the fixture in
   `test/unit/resources/registry.test.ts`, which checks that every real object renders.

## Adding an action

1. Add its identifier to `ALL_ACTIONS` (`src/shared/view.ts`); `extension.ts` registers a command for each. An action
   that changes the cluster also goes into `WRITE_ACTIONS` (`src/shared/protection.ts`): hidden on read-only contexts.
2. Declare the `kubexplorer.resource.<action>` command, its `webview/context` menu entry and its strings in
   `package.json` and `package.nls.json` (a unit test checks all of them).
3. Handle it in `ResourceActions.dispatch` and give it an icon in `src/webview/render.ts`. A change Flux would undo
   asks `FluxGuard.check` first.

## Design choices

- **kubectl rather than a JavaScript Kubernetes client**: the same authentication as the user's terminal
  (exec plugins, OIDC, cloud providers), no native dependencies; the store isolates this choice. A `kubectl proxy`
  per cluster keeps that authentication without a process per list.
- **Logs in a terminal rather than the Output panel**: one closable terminal per stream, with search, scrollback
  and colors; the Output channel is the extension log.
- **No `retainContextWhenHidden`**: the UI state is persisted with `setState`, so a hidden tab costs nothing.
- **`kubectl replace` on save**: conflicts are detected through `resourceVersion` and surface as save errors.
