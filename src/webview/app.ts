// Webview of a resource tab: header, table, details drawer, or overview.
// The UI state is persisted with setState so that the tab survives a reload of VS Code.
// The main list is virtual: only the rows in view are in the DOM, rendered again as the list scrolls. The extension
// sends the full list once, then what changed (rowsPatch, see rows.ts). Ages are computed here, and kept current by a
// timer. header.ts renders the pieces of the header, secrets.ts holds the Secret values revealed or edited.

import type { Protection } from "../shared/protection";
import type { Appearance, HostMessage, ListViewInit, NamespaceFilter, PersistedState, ViewInit, WebviewMessage } from "../shared/protocol";
import type { ActionId, Details, FleetTab, FleetView, MetricsData, OverviewData, ResourceRef, Row } from "../shared/view";
import { renderMetrics, tooltipHtml, valuesAt } from "./chart";
import { codicon, esc } from "./dom";
import { bulkBar, fleetData, fleetHeader, fleetStatus, namespaceSelect, protectionPill } from "./header";
import {
  renderDrawerContent,
  renderDrawerFrame,
  renderDrawerHeader,
  renderOverview,
  renderTableRows,
  renderVirtualTable,
  type TableOptions,
} from "./render";
import { ListRows } from "./rows";
import { SecretEdits } from "./secrets";

export interface VsCodeApi {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const DEFAULT_DRAWER_WIDTH = 640;
const MIN_DRAWER_WIDTH = 320;
/** Horizontal padding of the drawer content around the charts. */
const CHART_INSET = 40;
/** The ages in view are computed again every… */
const AGE_REFRESH_MS = 30_000;
/** Rows rendered above and below those in view, so that scrolling a little needs no rendering. */
const OVERSCAN_ROWS = 10;
/** Without a layout (tests), the list is as tall as… */
const DEFAULT_VIEWPORT_PX = 1000;
const DEFAULT_ROW_HEIGHT_PX = 28;

function sameTarget(a: PersistedState["panel"], b: PersistedState["panel"]): boolean {
  return !!a && !!b && a.context === b.context && JSON.stringify(a.target) === JSON.stringify(b.target);
}

export class App {
  private view?: ViewInit;
  private protection: Protection = "none";
  private readonly list = new ListRows();
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
  private readonly secrets = new SecretEdits((msg) => this.post(msg));
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
        this.list.replace(msg.rows);
        this.loading = msg.loading;
        this.error = msg.error;
        this.live = !!msg.live;
        break;
      case "rowsPatch":
        this.list.patch(msg.upsert, msg.remove, this.ui.sort);
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
          this.secrets.clear();
          if (this.metrics?.uid !== msg.details?.uid) this.metrics = undefined;
        }
        this.details = msg.details;
        this.detailsError = msg.error;
        this.detailsLoading = false;
        break;
      case "metrics":
        if (msg.uid === this.details?.uid) this.metrics = { uid: msg.uid, data: msg.data };
        break;
      case "secretValue":
        // Asked by an edit: its editor opens, focused.
        if (this.secrets.received(msg, msg.uid === this.details?.uid)) {
          this.render();
          return this.focusSecretEditor(msg.key);
        }
        break;
      case "secretUpdated":
        this.secrets.updated(msg);
        break;
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

  /** The rows matching the search, sorted. */
  private visibleRows(): Row[] {
    return this.list.visible(this.ui.search, this.ui.sort);
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

  private header(rows: Row[]): string {
    const v = this.view;
    if (!v) return "";
    if (v.mode === "fleet") return fleetHeader(this.fleet, v.title, this.ui.search);
    const isList = v.mode === "list";
    const all = this.list.all.length;
    const total = `${all} ${all === 1 ? "item" : "items"}`;
    const count = isList ? (rows.length === all ? total : `${rows.length} of ${total}`) : "";
    const showNamespaces = v.mode === "overview" || v.namespaced;
    return `
    <div class="title-row">
      <h1>${esc(v.title)}</h1>
      <span class="count">${count}</span>
      ${this.loading && all ? `<span class="spinner small" title="Loading"></span>` : ""}
      ${this.live && !this.error ? `<span class="live-pill" title="Updated in real time (watch)"><span class="live-dot"></span>Live</span>` : ""}
      ${this.error ? `<span class="error-pill" title="${esc(this.error)}">${codicon("warning")} ${esc(this.error.split("\n")[0])}</span>` : ""}
      ${protectionPill(this.protection, v.context)}
      ${isList ? bulkBar(this.checkedRows()) : ""}
      <span class="spacer"></span>
      ${showNamespaces ? namespaceSelect(this.ns, this.nsMenuOpen) : ""}
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

  /** The checked rows still listed. */
  private checkedRows(): Row[] {
    return this.list.all.filter((r) => this.checked.has(r.uid));
  }

  private body(rows: Row[]): string {
    const spinner = `<div class="empty"><div class="spinner"></div></div>`;
    const v = this.view;
    if (!v) return spinner;
    if (v.mode === "fleet") return this.fleet ? renderOverview(fleetData(this.fleet, this.ui.search), "", this.details?.uid) : spinner;
    if (v.mode === "overview") return this.overview ? renderOverview(this.overview, v.context, this.details?.uid) : spinner;
    if (this.loading && !this.list.all.length) return spinner;
    if (this.error && !this.list.all.length) return `<div class="empty error">${codicon("error")}<div>${esc(this.error)}</div></div>`;
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
    if (this.view?.mode === "fleet") this.region("r-fleet-status", fleetStatus(this.fleet));
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
        secrets: this.secrets.view(this.protection !== "readOnly"),
      }),
    );
    // The charts placeholder is part of the content: a new content has an empty one.
    if (replaced) this.rendered.delete("r-drawer-metrics");
    for (const editor of document.querySelectorAll<HTMLTextAreaElement>(".secret-editor")) {
      const draft = this.secrets.drafts.get(editor.dataset.key!) ?? "";
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
    this.secrets.clear();
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

  private bindEvents(): void {
    this.root.addEventListener("click", (ev) => this.onClick(ev));
    this.root.addEventListener("input", (ev) => {
      const t = ev.target as HTMLInputElement;
      // The draft follows the text without rendering, which would move the caret.
      if (t.classList.contains("secret-editor")) return void this.secrets.drafts.set(t.dataset.key!, t.value);
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
      this.secrets.cancel(key);
      this.render();
    } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && this.details) {
      ev.preventDefault();
      this.secrets.save(this.details.ref, key);
      this.render();
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
        this.post({ type: "fleetRun", what: d.what as "scan" | "diagnose" | "search" | "export", query: this.ui.search });
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
        if (ref && d.key) this.secrets.toggle(ref, d.key);
        return this.render();
      case "edit-secret": {
        // Known already: its editor opens now, focused; otherwise once its value arrives.
        const now = !!ref && !!d.key && this.secrets.edit(ref, d.key);
        this.render();
        if (now) this.focusSecretEditor(d.key!);
        return;
      }
      case "save-secret":
        if (ref && d.key) this.secrets.save(ref, d.key);
        return this.render();
      case "cancel-secret":
        if (d.key) this.secrets.cancel(d.key);
        return this.render();
      case "chart-tab":
        this.chartTab = d.chart ?? this.chartTab;
        this.renderMetrics();
        return;
      case "copy-secret": {
        const value = d.key ? this.secrets.values.get(d.key) : undefined;
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
