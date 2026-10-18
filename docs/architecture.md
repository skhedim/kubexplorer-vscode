# Architecture

KubeXplorer is split into layers. Only `src/vscode/` and `src/extension.ts` use the VS Code API; everything else is
plain TypeScript, unit tested with Vitest, and partly bundled into the browser preview. ESLint enforces the
boundaries.

```text
src/
  extension.ts        Entry point: wires the layers and registers the commands.
  kube/               Cluster access.
    client.ts           KubeClient interface (list, watch, YAML, logs, exec…).
    kubectl.ts          kubectl implementation; every call passes --context.
    demo.ts             In-memory demo cluster producing real `kubectl -o json` shaped objects.
    routing.ts          Routes to kubectl or the demo, and serves virtual lists.
    store.ts            Shared list cache: watch + list while subscribed, polling as a fallback.
    helm.ts             Helm client (CLI and demo); releases and charts as Kubernetes-shaped objects.
    portForward.ts      kubectl port-forward processes.
    jsonStream.ts       Splits the JSON stream of kubectl --watch.
    quantity.ts         Kubernetes quantities (CPU, memory).
    models.ts           Shapes of the Kubernetes sub-objects the descriptors read.
    virtualKinds.ts     Identifiers of the virtual lists.
  resources/          Kubernetes knowledge, declarative.
    descriptor.ts       defineResource(): columns, details and actions of a kind.
    pods.ts, workloads.ts, cluster.ts, config.ts, network.ts, storage.ts, access.ts, crd.ts, helm.ts,
    portForwards.ts, metrics.ts
    registry.ts         Built-in kinds plus CRDs registered at runtime.
    menu.ts             The Freelens side menu, shown by the Resources view.
    overview.ts         Cluster usage, status donuts and warning events.
    format.ts           Ages, cells and the metadata block shared by every drawer.
  panel/
    controller.ts       Logic of one tab: subscriptions while visible, rows, details, secret reveal.
  shared/             Contracts shared by the extension host and the webview.
    view.ts             Generic view model: columns, typed cells, detail sections.
    protocol.ts         HostMessage / WebviewMessage, persisted webview state.
    logFormat.ts, encoding.ts, clusterNames.ts
  webview/            UI of the tabs: framework-free HTML rendering by regions.
  vscode/             VS Code integration.
    clustersView.ts, resourcesView.ts   Tree views.
    panels.ts           Webview panels: tab reuse, serializer for restoring tabs after a restart.
    actions.ts          Actions with native dialogs, input boxes and quick picks.
    terminals.ts        Logs (Pseudoterminal) and shells (kubectl exec).
    documents.ts        kubexplorer:/ file system (save = kubectl replace), describe and read-only documents.
    clusterState.ts     Active cluster and namespaces per context (persisted).
    statusBar.ts, config.ts, logger.ts
```

## Data flow

1. The Resources view runs `kubexplorer.openResource("pods")`.
2. `ResourcePanels` reuses the current tab (or creates one) and gives it a `PanelController`.
3. Once the tab is visible and its webview has sent `ready`, the controller subscribes to the `ResourceStore`.
4. On every update, the controller turns objects into rows (`descriptor.toRow`) and posts them.
5. The webview sorts and filters locally, and sends intents back (`showDetails`, `action`, `revealSecret`…).
6. Actions go through `ResourceActions` (native UI), then `store.refresh()` updates the lists.

A hidden tab unsubscribes: a cluster is only queried for what is on screen.

## Real time

For every list, the store starts `kubectl get --watch-only --output-watch-events` **then** runs a full list: events
received while listing are merged (the highest `resourceVersion` wins), so no change falls in between. Event bursts
are coalesced (100 ms), a full resync runs every 5 minutes, and an interrupted watch resumes with a full list. APIs
that refuse watches (metrics.k8s.io) switch to polling after two immediate failures. Objects without `uid` (metrics)
are keyed by namespace and name.

## Related and virtual lists

- A descriptor can declare **related** lists: the controller subscribes to them and passes them to the row
  rendering (`RowContext`). Pods show their metrics this way (`podmetrics`).
- A **virtual** list is not served by `kubectl get` (Helm releases and charts, port forwards): `RoutingClient`
  delegates it to a `VirtualSource` returning Kubernetes-shaped objects, so lists, details, the store and actions
  work unchanged.

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

1. Add its identifier to `ALL_ACTIONS` (`src/shared/view.ts`); `extension.ts` registers a command for each.
2. Declare the `kubexplorer.resource.<action>` command, its `webview/context` menu entry and its strings in
   `package.json` and `package.nls.json` (a unit test checks all of them).
3. Handle it in `ResourceActions.dispatch` and give it an icon in `src/webview/render.ts`.

## Design choices

- **kubectl rather than a JavaScript Kubernetes client**: the same authentication as the user's terminal
  (exec plugins, OIDC, cloud providers), no native dependencies; the store isolates this choice.
- **Logs in a terminal rather than the Output panel**: one closable terminal per stream, with search, scrollback
  and colors; the Output channel is the extension log.
- **No `retainContextWhenHidden`**: the UI state is persisted with `setState`, so a hidden tab costs nothing.
- **`kubectl replace` on save**: conflicts are detected through `resourceVersion` and surface as save errors.
