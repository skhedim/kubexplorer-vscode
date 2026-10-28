// Webview of a resource tab: header, table, details drawer, or overview.
// The UI state is persisted with setState so that the tab survives a reload of VS Code.
// The main list is virtual: only the rows in view are in the DOM, rendered again as the list scrolls. The extension
// sends the full list once, then what changed (rowsPatch). Ages are computed here, and kept current by a timer.

import type { Protection } from "../shared/protection";
import type { Appearance, HostMessage, ListViewInit, NamespaceFilter, PersistedState, ViewInit, WebviewMessage } from "../shared/protocol";
import {
  type ActionId,
  BULK_ACTIONS,
  type Details,
  type FleetTab,
  type FleetView,
  type MetricsData,
  type OverviewData,
  type ResourceRef,
  type Row,
} from "../shared/view";
import { renderMetrics, tooltipHtml, valuesAt } from "./chart";
import { checkbox, codicon, data, esc } from "./dom";
import {
  ACTION_META,
  renderDrawerContent,
  renderDrawerFrame,
  renderDrawerHeader,
  renderOverview,
  renderTableRows,
  renderVirtualTable,
  type TableOptions,
} from "./render";

export interface VsCodeApi {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const DEFAULT_DRAWER_WIDTH = 640;
const MIN_DRAWER_WIDTH = 320;
/** Horizontal padding of the drawer content around the charts. */
const CHART_INSET = 40;
/**
 * Natural order ("pod-2" before "pod-10"), created once: localeCompare with options builds a collator at every call,
 * 20 times slower (190 ms instead of 10 ms to sort 5,000 rows).
 */
const collator = new Intl.Collator(undefined, { numeric: true });
/** The ages in view are computed again every… */
const AGE_REFRESH_MS = 30_000;
/** Rows rendered above and below those in view, so that scrolling a little needs no rendering. */
const OVERSCAN_ROWS = 10;
/** Without a layout (tests), the list is as tall as… */
const DEFAULT_VIEWPORT_PX = 1000;
const DEFAULT_ROW_HEIGHT_PX = 28;
/** A patch of more rows than this sorts the list again; a smaller one moves its rows only. */
const MAX_PATCH_INSERTS = 64;

type Sort = NonNullable<PersistedState["sort"]>;

/**
 * The order of a sort, total: rows of equal value follow their name, then namespace, so that a row put in place by a
 * patch lands where a full sort would put it (and rows do not swap places as they change).
 */
function compareRows(sort: Sort): (a: Row, b: Row) => number {
  return (a, b) => {
    const va = a.sort[sort.col] ?? "";
    const vb = b.sort[sort.col] ?? "";
    const r = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
    if (r) return sort.desc ? -r : r;
    return (
      collator.compare(a.ref.name, b.ref.name) ||
      collator.compare(a.ref.namespace ?? "", b.ref.namespace ?? "") ||
      (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
    );
  };
}

/** Where `row` goes in `rows`, sorted by `compare` (binary search). */
function insertionIndex(rows: Row[], row: Row, compare: (a: Row, b: Row) => number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(rows[mid], row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sameTarget(a: PersistedState["panel"], b: PersistedState["panel"]): boolean {
  return !!a && !!b && a.context === b.context && JSON.stringify(a.target) === JSON.stringify(b.target);
}

export class App {
  private view?: ViewInit;
  private protection: Protection = "none";
  private rows: Row[] = [];
  /** The rows by uid, to apply patches. */
  private rowIndex = new Map<string, Row>();
  /** Bumped by every change of the rows: the filtered and sorted rows are computed again only then. */
  private rowsVersion = 0;
  /** Every row, sorted: kept up to date by the patches, sorted again only when needed. */
  private sorted?: { version: number; col: string; desc: boolean; rows: Row[] };
  private visibleCache?: { key: string; rows: Row[] };
  private rowHeightPx?: number;
  private scrollFrame?: number;
  private loading = true;
  private live = false;
  private error?: string;
  private overview?: OverviewData;
  private fleet?: FleetView;
  private ns: NamespaceFilter = { available: [], selected: [] };
  private nsMenuOpen = false;
  private checked = new Set<string>();
  private details: Details | null = null;
  private detailsError?: string;
  private detailsLoading = false;
  private history: ResourceRef[] = [];
  /** Revealed Secret values of the object shown in the drawer. Never persisted. */
  private secretValues = new Map<string, string>();
  private secretPending = new Set<string>();
  private secretErrors = new Map<string, string>();
  /** Values being edited (draft per key), keys being saved, and keys to edit once their value arrives. */
  private secretDrafts = new Map<string, string>();
  private secretSaving = new Set<string>();
  private secretEditRequested = new Set<string>();
  /** Usage charts of the object shown in the drawer (uid of that object). */
  private metrics?: { uid: string; data: MetricsData | null };
  /** Selected chart tab, kept from one object to the next like in Freelens. */
  private chartTab = "cpu";
  private readonly rendered = new Map<string, string>();
  private ui: PersistedState;

  constructor(
    private readonly root: HTMLElement,
    private readonly vscode: VsCodeApi,
  ) {
    const saved = vscode.getState() as Partial<PersistedState> | undefined;
    this.ui = {
      search: saved?.search ?? "",
      sort: saved?.sort,
      selected: saved?.selected ?? null,
      drawerWidth: saved?.drawerWidth ?? DEFAULT_DRAWER_WIDTH,
      panel: saved?.panel,
    };
  }

  private readonly onMessage = (e: MessageEvent<HostMessage>) => this.onHostMessage(e.data);
  private ageTimer?: ReturnType<typeof setInterval>;

  start(): void {
    this.root.innerHTML = `<div class="app"><header id="r-header" class="header"></header><div class="main"><div id="r-body" class="body"></div><div id="r-drawer"></div></div></div>`;
    window.addEventListener("message", this.onMessage);
    this.bindEvents();
    this.ageTimer = setInterval(() => this.render(), AGE_REFRESH_MS);
    this.vscode.postMessage({ type: "ready" });
  }

  /** Stops listening to the extension (the webview itself never stops; tests do). */
  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    clearInterval(this.ageTimer);
  }

  private save(): void {
    this.vscode.setState(this.ui);
  }

  private post(msg: WebviewMessage): void {
    this.vscode.postMessage(msg);
  }

  private onHostMessage(msg: HostMessage): void {
    switch (msg.type) {
      case "init":
        this.init(msg.view, msg.appearance);
        break;
      case "appearance":
        this.setAppearance(msg.appearance);
        break;
      case "protection":
        this.setProtection(msg.protection);
        break;
      case "namespaces":
        this.ns = msg.filter;
        break;
      case "fleet":
        this.fleet = msg.view;
        break;
      case "reveal":
        return this.showDetails(msg.ref, false);
      case "rows":
        this.rows = msg.rows;
        this.rowIndex = new Map(msg.rows.map((r) => [r.uid, r]));
        this.rowsVersion++;
        this.loading = msg.loading;
        this.error = msg.error;
        this.live = !!msg.live;
        break;
      case "rowsPatch":
        for (const uid of msg.remove) this.rowIndex.delete(uid);
        for (const row of msg.upsert) this.rowIndex.set(row.uid, row);
        this.rows = [...this.rowIndex.values()];
        this.rowsVersion++;
        this.patchSorted(msg.upsert, msg.remove);
        this.loading = msg.loading;
        this.error = msg.error;
        this.live = !!msg.live;
        break;
      case "overview":
        this.overview = msg.data;
        this.loading = msg.loading;
        this.error = msg.error;
        this.live = !!msg.live;
        break;
      case "details":
        if (msg.details?.uid !== this.details?.uid) {
          this.clearSecrets();
          if (this.metrics?.uid !== msg.details?.uid) this.metrics = undefined;
        }
        this.details = msg.details;
        this.detailsError = msg.error;
        this.detailsLoading = false;
        break;
      case "metrics":
        if (msg.uid === this.details?.uid) this.metrics = { uid: msg.uid, data: msg.data };
        break;
      case "secretValue": {
        this.secretPending.delete(msg.key);
        const edit = this.secretEditRequested.delete(msg.key);
        if (msg.error) this.secretErrors.set(msg.key, msg.error);
        else if (msg.value !== undefined && msg.uid === this.details?.uid) {
          this.secretValues.set(msg.key, msg.value);
          if (edit) return this.startSecretEdit(msg.key, msg.value);
        }
        break;
      }
      case "secretUpdated": {
        this.secretSaving.delete(msg.key);
        const draft = this.secretDrafts.get(msg.key);
        if (msg.error) this.secretErrors.set(msg.key, msg.error);
        else if (msg.saved && draft !== undefined) {
          // Saved: the new value stays shown, like a revealed one.
          this.secretDrafts.delete(msg.key);
          this.secretValues.set(msg.key, draft);
        }
        break;
      }
    }
    this.render();
  }

  private init(view: ViewInit, appearance: Appearance): void {
    const panel: PersistedState["panel"] = { context: view.context, target: view.target };
    // A reused tab now shows another resource type: start from a clean UI state.
    if (this.ui.panel && !sameTarget(this.ui.panel, panel)) {
      this.ui = { search: "", selected: null, drawerWidth: this.ui.drawerWidth, panel };
    }
    this.view = view;
    this.ui.panel = panel;
    if (view.mode === "list") this.ui.sort ??= view.defaultSort;
    this.setAppearance(appearance);
    this.setProtection(view.protection ?? "none");
    this.save();
    if (this.ui.selected) this.showDetails(this.ui.selected, false);
  }

  private setAppearance(appearance: Appearance): void {
    document.body.dataset.appearance = appearance;
    // The rows of the Freelens appearance are taller.
    this.rowHeightPx = undefined;
  }

  /** A protected context: a colored frame around the tab, and a pill in the header. */
  private setProtection(protection: Protection): void {
    this.protection = protection;
    document.body.dataset.protection = protection;
  }

  private clearSecrets(): void {
    this.secretValues.clear();
    this.secretPending.clear();
    this.secretErrors.clear();
    this.secretDrafts.clear();
    this.secretSaving.clear();
    this.secretEditRequested.clear();
  }

  // ---------------- Rendering ----------------

  /** Updates a region when its HTML changed; returns whether it did. */
  private region(id: string, html: string): boolean {
    const el = document.getElementById(id);
    // A region inside another one (e.g. the fleet status in the header) exists only once that one is rendered.
    if (!el || this.rendered.get(id) === html) return false;
    this.rendered.set(id, html);
    el.innerHTML = html;
    return true;
  }

  /** Every row, in the order of the sort. */
  private sortedRows(): Row[] {
    const sort = this.ui.sort;
    if (!sort) return this.rows;
    const s = this.sorted;
    if (s?.version === this.rowsVersion && s.col === sort.col && s.desc === sort.desc) return s.rows;
    const rows = [...this.rows].sort(compareRows(sort));
    this.sorted = { version: this.rowsVersion, ...sort, rows };
    return rows;
  }

  /** Moves the rows of a small patch to their place in the sorted rows, rather than sorting them all again. */
  private patchSorted(upsert: Row[], remove: string[]): void {
    const s = this.sorted;
    const sort = this.ui.sort;
    if (
      !s ||
      !sort ||
      s.version !== this.rowsVersion - 1 ||
      s.col !== sort.col ||
      s.desc !== sort.desc ||
      upsert.length > MAX_PATCH_INSERTS
    ) {
      this.sorted = undefined;
      return;
    }
    const gone = new Set([...remove, ...upsert.map((r) => r.uid)]);
    const rows = s.rows.filter((r) => !gone.has(r.uid));
    const compare = compareRows(sort);
    for (const row of upsert) rows.splice(insertionIndex(rows, row, compare), 0, row);
    this.sorted = { ...s, version: this.rowsVersion, rows };
  }

  /** The rows matching the search, sorted; computed again only when the rows, the search or the sort change. */
  private visibleRows(): Row[] {
    const sort = this.ui.sort;
    const key = `${this.rowsVersion}|${sort?.col}|${sort?.desc}|${this.ui.search}`;
    if (this.visibleCache?.key === key) return this.visibleCache.rows;
    const terms = this.ui.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sorted = this.sortedRows();
    const rows = terms.length ? sorted.filter((r) => terms.every((t) => r.search.includes(t))) : sorted;
    this.visibleCache = { key, rows };
    return rows;
  }

  private tableOptions(rows: Row[]): TableOptions {
    const v = this.view as ListViewInit;
    return {
      context: v.context,
      columns: v.columns,
      rows,
      selectedUid: this.ui.selected ? this.details?.uid : undefined,
      interactive: true,
      checked: this.checked,
      sort: this.ui.sort,
      empty: this.ui.search ? "No item matches the search" : "No item",
    };
  }

  /** Height of a row of the main list (--kx-row-height), in pixels. */
  private rowHeight(): number {
    this.rowHeightPx ??= parseFloat(getComputedStyle(document.body).getPropertyValue("--kx-row-height")) || DEFAULT_ROW_HEIGHT_PX;
    return this.rowHeightPx;
  }

  /** Renders the rows of the main list in view, and a few around: the others are not in the DOM. */
  private renderWindow(rows: Row[]): void {
    const win = document.getElementById("r-rows");
    const body = document.getElementById("r-body");
    if (!win || !body) return;
    const height = this.rowHeight();
    const head = body.querySelector<HTMLElement>(".row.head")?.offsetHeight ?? 0;
    const first = Math.floor(Math.max(0, body.scrollTop - head) / height);
    const start = Math.max(0, first - OVERSCAN_ROWS);
    const end = Math.min(rows.length, first + Math.ceil((body.clientHeight || DEFAULT_VIEWPORT_PX) / height) + OVERSCAN_ROWS);
    // In CSS units: the same height as the sizer, whatever the zoom.
    win.style.transform = `translateY(calc(var(--kx-row-height) * ${start}))`;
    this.region("r-rows", renderTableRows(this.tableOptions(rows), start, end));
  }

  /** Scrolls the main list so that the row at `index` is in view, below the sticky head. */
  private scrollToRow(index: number): void {
    const body = document.getElementById("r-body");
    if (!body) return;
    const height = this.rowHeight();
    const top = index * height;
    const view = (body.clientHeight || DEFAULT_VIEWPORT_PX) - (body.querySelector<HTMLElement>(".row.head")?.offsetHeight ?? 0);
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + height > body.scrollTop + view) body.scrollTop = top + height - view;
    this.renderWindow(this.visibleRows());
  }

  private onScroll(): void {
    if (this.view?.mode !== "list" || this.scrollFrame !== undefined) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = undefined;
      this.renderWindow(this.visibleRows());
    });
  }

  private namespaceSelect(): string {
    const sel = this.ns.selected;
    const label = sel.length === 0 ? "All namespaces" : sel.length <= 2 ? sel.join(", ") : `${sel.length} namespaces`;
    const options = [
      `<div role="option" class="option" aria-selected="${sel.length === 0}" ${data({ action: "ns-all" })}>${checkbox(sel.length === 0, "ns-all")}<span>All namespaces</span></div>`,
      ...this.ns.available.map(
        (n) =>
          `<div role="option" class="option" aria-selected="${sel.includes(n)}" ${data({ action: "ns-toggle", ns: n })}>${checkbox(sel.includes(n), "ns-toggle", { ns: n })}<span>${esc(n)}</span></div>`,
      ),
    ].join("");
    return `
    <div class="ns-select${this.nsMenuOpen ? " open" : ""}">
      <button type="button" class="select-control" ${data({ action: "ns-menu" })} aria-haspopup="listbox" aria-expanded="${this.nsMenuOpen}" title="Filter namespaces">
        ${codicon("layers")}<span class="select-value">${esc(label)}</span>${codicon("chevron-down")}
      </button>
      ${this.nsMenuOpen ? `<div class="select-menu" role="listbox" aria-multiselectable="true">${options}</div>` : ""}
    </div>`;
  }

  private header(rows: Row[]): string {
    const v = this.view;
    if (!v) return "";
    if (v.mode === "fleet") return this.fleetHeader();
    const isList = v.mode === "list";
    const total = `${this.rows.length} ${this.rows.length === 1 ? "item" : "items"}`;
    const count = isList ? (rows.length === this.rows.length ? total : `${rows.length} of ${total}`) : "";
    const showNamespaces = v.mode === "overview" || v.namespaced;
    return `
    <div class="title-row">
      <h1>${esc(v.title)}</h1>
      <span class="count">${count}</span>
      ${this.loading && this.rows.length ? `<span class="spinner small" title="Loading"></span>` : ""}
      ${this.live && !this.error ? `<span class="live-pill" title="Updated in real time (watch)"><span class="live-dot"></span>Live</span>` : ""}
      ${this.error ? `<span class="error-pill" title="${esc(this.error)}">${codicon("warning")} ${esc(this.error.split("\n")[0])}</span>` : ""}
      ${this.protectionPill(v.context)}
      ${isList ? this.bulkBar() : ""}
      <span class="spacer"></span>
      ${showNamespaces ? this.namespaceSelect() : ""}
      ${
        isList
          ? `<label class="search">${codicon("search")}<input id="search" type="text" placeholder="Search ${esc(v.title)}…" value="${esc(this.ui.search)}" spellcheck="false" aria-label="Search">${
              this.ui.search ? codicon("close", { action: "clear-search", title: "Clear" }) : ""
            }</label>`
          : ""
      }
      ${codicon("refresh", { action: "refresh", title: "Refresh" })}
    </div>`;
  }

  // ---------------- Fleet ----------------

  private fleetHeader(): string {
    const f = this.fleet;
    if (!f) return `<div class="title-row"><h1>Fleet</h1></div>`;
    const chip = (label: string, active: boolean, attrs: Record<string, unknown>, title?: string) =>
      `<button type="button" class="chip${active ? " active" : ""}" aria-pressed="${active}"${title ? ` title="${esc(title)}"` : ""} ${data(attrs)}>${label}</button>`;
    const tabs: [FleetTab, string, string][] = [
      ["clusters", "server-environment", "Clusters"],
      ["flux", "sync", "Flux"],
      ["diagnostics", "checklist", "Diagnostics"],
      ["search", "search", "Search"],
    ];
    const groups =
      f.groups.length > 1
        ? `<span class="chips" role="group" aria-label="Group">${chip("All", f.group === null, { action: "fleet-group", group: "" })}${f.groups
            .map((g) => chip(esc(g), f.group === g, { action: "fleet-group", group: g }))
            .join("")}</span>`
        : "";
    const searchTab = f.tab === "search";
    const kinds = searchTab
      ? `<select id="fleet-kind" class="select" aria-label="Kind">${f.searchKinds
          .map((k) => `<option value="${esc(k.id)}"${k.id === f.searchKind ? " selected" : ""}>${esc(k.label)}</option>`)
          .join("")}</select>`
      : "";
    const placeholder = searchTab ? "Name, image or host… then Enter" : `Filter ${f.tab}…`;
    const run =
      f.tab === "diagnostics"
        ? `<button type="button" class="button" ${data({ action: "fleet-run", what: "diagnose" })}>${codicon("play")} Run diagnostics</button>`
        : searchTab
          ? `<button type="button" class="button" ${data({ action: "fleet-run", what: "search" })}>${codicon("search")} Search</button>`
          : "";
    return `
    <div class="title-row">
      <h1>${esc(this.view?.title ?? "Fleet")}</h1>
      <span class="count" id="r-fleet-status"></span>
      <span class="spacer"></span>
      ${groups}
      ${f.tab !== "search" ? chip(`${codicon("warning")} Problems only`, f.problemsOnly, { action: "fleet-problems" }, "Only the clusters or objects with a problem") : ""}
      ${kinds}
      <label class="search">${codicon("search")}<input id="search" type="text" placeholder="${esc(placeholder)}" value="${esc(this.ui.search)}" spellcheck="false" aria-label="${searchTab ? "Search the clusters" : "Filter"}">${
        this.ui.search ? codicon("close", { action: "clear-search", title: "Clear" }) : ""
      }</label>
      ${run}
      ${codicon("refresh", { action: "fleet-run", title: "Scan the clusters now", attrs: { what: "scan" } })}
    </div>
    <div class="fleet-tabs" role="tablist">${tabs
      .map(
        ([id, icon, label]) =>
          `<button type="button" role="tab" class="fleet-tab${f.tab === id ? " active" : ""}" aria-selected="${f.tab === id}" ${data({ action: "fleet-tab", tab: id })}>${codicon(icon)} ${label}</button>`,
      )
      .join("")}</div>`;
  }

  private fleetStatus(): string {
    const f = this.fleet;
    if (!f) return "";
    const progress = f.progress
      ? ` · <span class="spinner small"></span> ${esc(f.progress.label)} ${f.progress.done}/${f.progress.total}`
      : f.updated
        ? ` · ${esc(f.updated)}`
        : "";
    return `${f.clusters} ${f.clusters === 1 ? "cluster" : "clusters"}${progress}`;
  }

  /** The data of the tab, its rows filtered by the text of the search box (but on the Search tab). */
  private fleetData(f: FleetView): OverviewData {
    const terms = f.tab === "search" ? [] : this.ui.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return f.data;
    return {
      ...f.data,
      tables: f.data.tables.map((t) => ({ ...t, rows: t.rows.filter((r) => terms.every((term) => r.search.includes(term))) })),
    };
  }

  private protectionPill(context: string): string {
    if (this.protection === "none") return "";
    const readOnly = this.protection === "readOnly";
    const title = readOnly
      ? `${context} is read-only: the actions that change the cluster are disabled (kubexplorer.protectedContexts)`
      : `${context} is protected: every change asks you to type the name of its target (kubexplorer.protectedContexts)`;
    return `<span class="protected-pill" title="${esc(title)}">${codicon(readOnly ? "lock" : "shield")} ${readOnly ? "Read-only" : "Protected"}</span>`;
  }

  /** The checked rows still listed. */
  private checkedRows(): Row[] {
    return this.rows.filter((r) => this.checked.has(r.uid));
  }

  /** Actions on the checked rows: those every checked row supports. */
  private bulkBar(): string {
    const rows = this.checkedRows();
    if (!rows.length) return "";
    const actions = BULK_ACTIONS.filter((a) => rows.every((r) => r.actions.includes(a)));
    const buttons = actions
      .map(
        (a) =>
          `<button type="button" class="button${a === "delete" ? " danger" : ""}" ${data({ action: "bulk", act: a })}>${codicon(ACTION_META[a].icon)} ${esc(ACTION_META[a].title)}</button>`,
      )
      .join("");
    return `<span class="bulk-bar" role="toolbar" aria-label="Actions on the selected items"><span class="bulk-count">${rows.length} selected</span>${buttons}${codicon("close", { action: "uncheck-all", title: "Clear selection" })}</span>`;
  }

  private body(rows: Row[]): string {
    const spinner = `<div class="empty"><div class="spinner"></div></div>`;
    const v = this.view;
    if (!v) return spinner;
    if (v.mode === "fleet") return this.fleet ? renderOverview(this.fleetData(this.fleet), "", this.details?.uid) : spinner;
    if (v.mode === "overview") return this.overview ? renderOverview(this.overview, v.context, this.details?.uid) : spinner;
    if (this.loading && !this.rows.length) return spinner;
    if (this.error && !this.rows.length) return `<div class="empty error">${codicon("error")}<div>${esc(this.error)}</div></div>`;
    return renderVirtualTable(this.tableOptions(rows), "r-rows");
  }

  render(): void {
    const active = document.activeElement as HTMLInputElement | null;
    const searchFocused = active?.id === "search";
    const caret = searchFocused ? active.selectionStart : null;
    // A Secret value being typed survives a refresh of the drawer, with its caret.
    const editor = active?.classList.contains("secret-editor") ? active : null;
    const editorState = editor && { key: editor.dataset.key!, start: editor.selectionStart, end: editor.selectionEnd };
    const bodyEl = document.getElementById("r-body")!;
    const scroll = bodyEl.scrollTop;
    const drawerScroll = document.querySelector(".drawer-content")?.scrollTop ?? 0;

    const rows = this.visibleRows();
    // The status of the fleet (progress, last scan) changes often: its own region keeps the controls still.
    if (this.region("r-header", this.header(rows))) this.rendered.delete("r-fleet-status");
    if (this.view?.mode === "fleet") this.region("r-fleet-status", this.fleetStatus());
    // A new frame of the list has an empty window of rows.
    if (this.region("r-body", this.body(rows))) this.rendered.delete("r-rows");
    this.renderDrawer();

    bodyEl.scrollTop = scroll;
    // Once the scroll position is restored: it tells which rows are in view.
    if (this.view?.mode === "list") this.renderWindow(rows);
    const drawerContent = document.querySelector(".drawer-content");
    if (drawerContent) drawerContent.scrollTop = drawerScroll;
    if (searchFocused) {
      const input = document.getElementById("search") as HTMLInputElement | null;
      input?.focus();
      if (caret !== null) input?.setSelectionRange(caret, caret);
    }
    if (editorState) this.focusSecretEditor(editorState.key, editorState.start, editorState.end);
  }

  private focusSecretEditor(key: string, start?: number | null, end?: number | null): void {
    const editor = [...document.querySelectorAll<HTMLTextAreaElement>(".secret-editor")].find((e) => e.dataset.key === key);
    if (!editor || document.activeElement === editor) return;
    editor.focus();
    const length = editor.value.length;
    editor.setSelectionRange(start ?? length, end ?? length);
  }

  /** Opens or closes the drawer frame, then updates its header and content in place. */
  private renderDrawer(): void {
    const container = document.getElementById("r-drawer")!;
    if (!this.ui.selected) {
      if (container.firstChild) {
        container.replaceChildren();
        this.rendered.delete("r-drawer-header");
        this.rendered.delete("r-drawer-content");
      }
      return;
    }
    if (!container.firstChild) container.innerHTML = renderDrawerFrame(this.ui.drawerWidth);
    this.region("r-drawer-header", renderDrawerHeader(this.details, this.history.length > 0));
    const replaced = this.region(
      "r-drawer-content",
      renderDrawerContent(this.details, {
        context: this.view?.context ?? "",
        error: this.detailsError,
        loading: this.detailsLoading,
        secrets: {
          values: this.secretValues,
          pending: this.secretPending,
          errors: this.secretErrors,
          drafts: this.secretDrafts,
          saving: this.secretSaving,
          editable: this.protection !== "readOnly",
        },
      }),
    );
    // The charts placeholder is part of the content: a new content has an empty one.
    if (replaced) this.rendered.delete("r-drawer-metrics");
    for (const editor of document.querySelectorAll<HTMLTextAreaElement>(".secret-editor")) {
      const draft = this.secretDrafts.get(editor.dataset.key!) ?? "";
      if (editor.value !== draft) editor.value = draft;
    }
    this.renderMetrics();
  }

  private renderMetrics(): void {
    if (!document.getElementById("r-drawer-metrics")) return;
    const content = document.getElementById("r-drawer-content");
    const width = Math.max(240, (content?.clientWidth || this.ui.drawerWidth) - CHART_INSET);
    const metrics = this.metrics?.uid === this.details?.uid ? (this.metrics?.data ?? undefined) : undefined;
    // null: the object has no charts after all (e.g. a workload without pods).
    const html = this.metrics?.data === null && this.metrics.uid === this.details?.uid ? "" : renderMetrics(metrics, this.chartTab, width);
    this.region("r-drawer-metrics", html);
  }

  /** Moves the cursor of the chart under the mouse and shows the values at that time. */
  private onChartHover(ev: MouseEvent): void {
    const svg = (ev.target as Element).closest<SVGSVGElement>(".chart-svg");
    const chartEl = svg?.parentElement;
    const tooltip = chartEl?.querySelector<HTMLElement>(".chart-tooltip");
    const cursor = svg?.querySelector(".cursor");
    const chart = this.metrics?.data?.charts.find((c) => c.id === svg?.dataset.chart);
    if (!svg || !tooltip || !cursor || !chart) return;
    const box = svg.getBoundingClientRect();
    const { tmin, tmax, left, right } = svg.dataset;
    const px = ev.clientX - box.left;
    const [t0, t1, x0, x1] = [Number(tmin), Number(tmax), Number(left), Number(right)];
    const values = px >= x0 && px <= x1 ? valuesAt(chart, t0 + ((px - x0) / (x1 - x0)) * (t1 - t0)) : undefined;
    if (!values) return this.hideChartHover(svg);
    const cx = x0 + ((values.time - t0) / (t1 - t0)) * (x1 - x0);
    cursor.setAttribute("x1", String(cx));
    cursor.setAttribute("x2", String(cx));
    cursor.setAttribute("visibility", "visible");
    tooltip.innerHTML = tooltipHtml(values);
    tooltip.hidden = false;
    // On the right of the cursor, or on its left near the right edge.
    const flip = cx > box.width / 2;
    tooltip.style.left = flip ? "" : `${cx + 12}px`;
    tooltip.style.right = flip ? `${box.width - cx + 12}px` : "";
  }

  private hideChartHover(svg: Element): void {
    svg.querySelector(".cursor")?.setAttribute("visibility", "hidden");
    const tooltip = svg.parentElement?.querySelector<HTMLElement>(".chart-tooltip");
    if (tooltip) tooltip.hidden = true;
  }

  // ---------------- Actions ----------------

  private showDetails(ref: ResourceRef | null, pushHistory: boolean): void {
    if (pushHistory && this.ui.selected && ref) this.history.push(this.ui.selected);
    if (!ref) this.history = [];
    this.ui.selected = ref;
    this.details = null;
    this.detailsError = undefined;
    this.detailsLoading = !!ref;
    this.clearSecrets();
    this.save();
    this.post({ type: "showDetails", ref });
    // Another object: start the content from the top.
    this.rendered.delete("r-drawer-content");
    document.querySelector(".drawer-content")?.scrollTo(0, 0);
    this.render();
  }

  private moveSelection(delta: number): void {
    const rows = this.visibleRows();
    const selected = this.ui.selected;
    if (!rows.length || !selected) return;
    const i = rows.findIndex(
      (r) => r.ref.name === selected.name && r.ref.namespace === selected.namespace && r.ref.resource === selected.resource,
    );
    const index = Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta));
    this.history = [];
    this.showDetails(rows[index].ref, false);
    this.scrollToRow(index);
  }

  /** Edits a value in place, once known: revealed first when hidden. */
  private editSecret(ref: ResourceRef, key: string): void {
    const value = this.secretValues.get(key);
    if (value !== undefined) return this.startSecretEdit(key, value);
    this.secretErrors.delete(key);
    this.secretPending.add(key);
    this.secretEditRequested.add(key);
    this.post({ type: "revealSecret", ref, key });
    this.render();
  }

  private startSecretEdit(key: string, value: string): void {
    this.secretErrors.delete(key);
    this.secretDrafts.set(key, value);
    this.render();
    this.focusSecretEditor(key);
  }

  private saveSecret(ref: ResourceRef, key: string): void {
    const value = this.secretDrafts.get(key);
    if (value === undefined || this.secretSaving.has(key)) return;
    this.secretErrors.delete(key);
    this.secretSaving.add(key);
    this.post({ type: "updateSecret", ref, key, value });
    this.render();
  }

  private cancelSecretEdit(key: string): void {
    this.secretDrafts.delete(key);
    this.secretErrors.delete(key);
    this.render();
  }

  private toggleSecret(ref: ResourceRef, key: string): void {
    if (this.secretValues.delete(key)) return this.render();
    this.secretErrors.delete(key);
    this.secretPending.add(key);
    this.post({ type: "revealSecret", ref, key });
    this.render();
  }

  private bindEvents(): void {
    this.root.addEventListener("click", (ev) => this.onClick(ev));
    this.root.addEventListener("input", (ev) => {
      const t = ev.target as HTMLInputElement;
      // The draft follows the text without rendering, which would move the caret.
      if (t.classList.contains("secret-editor")) return void this.secretDrafts.set(t.dataset.key!, t.value);
      if (t.id !== "search") return;
      this.ui.search = t.value;
      this.save();
      this.render();
    });
    this.root.addEventListener("mousedown", (ev) => this.onDragStart(ev));
    document.getElementById("r-body")!.addEventListener("scroll", () => this.onScroll(), { passive: true });
    window.addEventListener("resize", () => this.onScroll());
    this.root.addEventListener("change", (ev) => {
      const t = ev.target as HTMLSelectElement;
      if (t.id === "fleet-kind") this.post({ type: "fleetState", searchKind: t.value });
    });
    this.root.addEventListener("mousemove", (ev) => this.onChartHover(ev));
    this.root.addEventListener("mouseout", (ev) => {
      const svg = (ev.target as Element).closest?.(".chart-svg");
      if (svg && !svg.contains(ev.relatedTarget as Node | null)) this.hideChartHover(svg);
    });
    window.addEventListener("keydown", (ev) => this.onKeyDown(ev));
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement;
    if (target.classList?.contains("secret-editor")) return this.onSecretEditorKey(ev, target.dataset.key!);
    const inInput = target.tagName === "INPUT";
    if (ev.key === "Enter" && target.id === "search" && this.fleet?.tab === "search") {
      ev.preventDefault();
      return this.post({ type: "fleetRun", what: "search", query: this.ui.search });
    }
    if (ev.key === "Escape") {
      if (this.nsMenuOpen) this.nsMenuOpen = false;
      else if (inInput && this.ui.search) this.ui.search = "";
      else if (this.ui.selected) return this.showDetails(null, false);
      this.save();
      this.render();
    } else if ((ev.key === "f" && (ev.ctrlKey || ev.metaKey)) || (ev.key === "/" && !inInput)) {
      ev.preventDefault();
      (document.getElementById("search") as HTMLInputElement | null)?.focus();
    } else if (!inInput && this.ui.selected && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      this.moveSelection(ev.key === "ArrowDown" ? 1 : -1);
    }
  }

  private onSecretEditorKey(ev: KeyboardEvent, key: string): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.cancelSecretEdit(key);
    } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && this.details) {
      ev.preventDefault();
      this.saveSecret(this.details.ref, key);
    }
  }

  private onDragStart(ev: MouseEvent): void {
    const handle = (ev.target as HTMLElement).closest<HTMLElement>("[data-drag]");
    if (!handle) return;
    ev.preventDefault();
    document.body.classList.add("resizing");
    const main = document.querySelector(".main")!.getBoundingClientRect();
    const move = (e: MouseEvent) => {
      this.ui.drawerWidth = Math.round(Math.max(MIN_DRAWER_WIDTH, Math.min(main.width - 120, main.right - e.clientX)));
      document.querySelector<HTMLElement>(".drawer")?.style.setProperty("--drawer-width", `${this.ui.drawerWidth}px`);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.save();
      // The charts are drawn at the width of the drawer.
      this.renderMetrics();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  private onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement;
    const el = target.closest<HTMLElement>("[data-action]");
    if (this.nsMenuOpen && !target.closest(".ns-select")) {
      this.nsMenuOpen = false;
      if (!el) return this.render();
    }
    if (!el) return;
    ev.preventDefault();
    const d = el.dataset;
    const ref = d.ref ? (JSON.parse(d.ref) as ResourceRef) : undefined;
    switch (d.action) {
      case "fleet-tab":
        this.ui.search = "";
        this.post({ type: "fleetState", tab: d.tab as FleetTab });
        return;
      case "fleet-group":
        this.post({ type: "fleetState", group: d.group || null });
        return;
      case "fleet-problems":
        this.post({ type: "fleetState", problemsOnly: !this.fleet?.problemsOnly });
        return;
      case "fleet-run":
        this.post({ type: "fleetRun", what: d.what as "scan" | "diagnose" | "search", query: this.ui.search });
        return;
      case "open-row":
        // An object of another cluster (fleet) opens in a tab of that cluster.
        if (ref?.context) this.post({ type: "openInCluster", ref });
        else if (ref) this.showDetails(this.ui.selected && this.details?.uid === d.uid ? null : ref, false);
        return;
      case "open-ref":
        if (ref?.context) this.post({ type: "openInCluster", ref });
        else if (ref) this.showDetails(ref, true);
        return;
      case "details-back":
        this.showDetails(this.history.pop() ?? null, false);
        return;
      case "close-drawer":
        this.showDetails(null, false);
        return;
      case "action":
        if (ref) this.post({ type: "action", action: d.act as ActionId, ref, container: d.container });
        return;
      case "row-menu":
        ev.stopPropagation();
        if (ref) this.post({ type: "rowMenu", ref, actions: (d.actions ?? "").split(",") as ActionId[] });
        return;
      case "toggle-secret":
        if (ref && d.key) this.toggleSecret(ref, d.key);
        return;
      case "edit-secret":
        if (ref && d.key) this.editSecret(ref, d.key);
        return;
      case "save-secret":
        if (ref && d.key) this.saveSecret(ref, d.key);
        return;
      case "cancel-secret":
        if (d.key) this.cancelSecretEdit(d.key);
        return;
      case "chart-tab":
        this.chartTab = d.chart ?? this.chartTab;
        this.renderMetrics();
        return;
      case "copy-secret": {
        const value = d.key ? this.secretValues.get(d.key) : undefined;
        if (value !== undefined) this.post({ type: "copyText", text: value });
        return;
      }
      case "sort": {
        const cur = this.ui.sort;
        this.ui.sort = cur && cur.col === d.col ? { col: d.col, desc: !cur.desc } : { col: d.col!, desc: false };
        break;
      }
      case "check":
        ev.stopPropagation();
        if (!this.checked.delete(d.uid!)) this.checked.add(d.uid!);
        break;
      case "check-all": {
        const rows = this.visibleRows();
        const all = rows.length > 0 && rows.every((r) => this.checked.has(r.uid));
        this.checked = all ? new Set() : new Set(rows.map((r) => r.uid));
        break;
      }
      case "bulk": {
        const action = d.act as ActionId;
        this.post({ type: "bulkAction", action, refs: this.checkedRows().map((r) => r.ref) });
        // Deleted rows disappear; the other actions keep the selection, to chain them (e.g. scale, then restart).
        if (action === "delete") this.checked.clear();
        break;
      }
      case "uncheck-all":
        this.checked.clear();
        break;
      case "ns-menu":
        this.nsMenuOpen = !this.nsMenuOpen;
        break;
      case "ns-all":
        this.post({ type: "setNamespaces", namespaces: [] });
        break;
      case "ns-toggle": {
        const n = d.ns!;
        const selected = this.ns.selected.includes(n) ? this.ns.selected.filter((x) => x !== n) : [...this.ns.selected, n];
        this.post({ type: "setNamespaces", namespaces: selected });
        break;
      }
      case "clear-search":
        this.ui.search = "";
        break;
      case "refresh":
        this.post({ type: "refresh" });
        break;
      case "open-resource":
        this.post({ type: "openResource", resource: d.resource! });
        return;
    }
    this.save();
    this.render();
  }
}
