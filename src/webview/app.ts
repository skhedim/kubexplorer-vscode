// Webview of a resource tab: header, table, details drawer, or overview.
// The UI state is persisted with setState so that the tab survives a reload of VS Code.

import type { Appearance, HostMessage, NamespaceFilter, PersistedState, ViewInit, WebviewMessage } from "../shared/protocol";
import type { ActionId, Details, OverviewData, ResourceRef, Row } from "../shared/view";
import { checkbox, codicon, data, esc } from "./dom";
import { renderDrawerContent, renderDrawerFrame, renderDrawerHeader, renderOverview, renderTable } from "./render";

export interface VsCodeApi {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const DEFAULT_DRAWER_WIDTH = 640;
const MIN_DRAWER_WIDTH = 320;

function sameTarget(a: PersistedState["panel"], b: PersistedState["panel"]): boolean {
  return !!a && !!b && a.context === b.context && JSON.stringify(a.target) === JSON.stringify(b.target);
}

export class App {
  private view?: ViewInit;
  private rows: Row[] = [];
  private loading = true;
  private live = false;
  private error?: string;
  private overview?: OverviewData;
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

  start(): void {
    this.root.innerHTML = `<div class="app"><header id="r-header" class="header"></header><div class="main"><div id="r-body" class="body"></div><div id="r-drawer"></div></div></div>`;
    window.addEventListener("message", (e: MessageEvent<HostMessage>) => this.onHostMessage(e.data));
    this.bindEvents();
    this.vscode.postMessage({ type: "ready" });
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
      case "namespaces":
        this.ns = msg.filter;
        break;
      case "rows":
        this.rows = msg.rows;
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
        if (msg.details?.uid !== this.details?.uid) this.clearSecrets();
        this.details = msg.details;
        this.detailsError = msg.error;
        this.detailsLoading = false;
        break;
      case "secretValue":
        this.secretPending.delete(msg.key);
        if (msg.error) this.secretErrors.set(msg.key, msg.error);
        else if (msg.value !== undefined && msg.uid === this.details?.uid) this.secretValues.set(msg.key, msg.value);
        break;
    }
    this.render();
  }

  private init(view: ViewInit, appearance: Appearance): void {
    const panel: PersistedState["panel"] = {
      context: view.context,
      target: view.mode === "list" ? { kind: "list", resource: view.resource } : { kind: "overview" },
    };
    // A reused tab now shows another resource type: start from a clean UI state.
    if (this.ui.panel && !sameTarget(this.ui.panel, panel)) {
      this.ui = { search: "", selected: null, drawerWidth: this.ui.drawerWidth, panel };
    }
    this.view = view;
    this.ui.panel = panel;
    if (view.mode === "list") this.ui.sort ??= view.defaultSort;
    this.setAppearance(appearance);
    this.save();
    if (this.ui.selected) this.showDetails(this.ui.selected, false);
  }

  private setAppearance(appearance: Appearance): void {
    document.body.dataset.appearance = appearance;
  }

  private clearSecrets(): void {
    this.secretValues.clear();
    this.secretPending.clear();
    this.secretErrors.clear();
  }

  // ---------------- Rendering ----------------

  private region(id: string, html: string): void {
    if (this.rendered.get(id) === html) return;
    this.rendered.set(id, html);
    document.getElementById(id)!.innerHTML = html;
  }

  private visibleRows(): Row[] {
    const terms = this.ui.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = terms.length ? this.rows.filter((r) => terms.every((t) => r.search.includes(t))) : this.rows;
    const sort = this.ui.sort;
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const va = a.sort[sort.col] ?? "";
      const vb = b.sort[sort.col] ?? "";
      const r =
        typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return sort.desc ? -r : r;
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
    const isList = v.mode === "list";
    const total = `${this.rows.length} ${this.rows.length === 1 ? "item" : "items"}`;
    const count = isList ? (rows.length === this.rows.length ? total : `${rows.length} of ${total}`) : "";
    const showNamespaces = v.mode === "overview" || v.namespaced;
    return `
    <div class="title-row">
      <h1>${esc(v.title)}</h1>
      <span class="count">${count}</span>
      ${this.loading && this.rows.length ? `<span class="spinner small" title="Loading"></span>` : ""}
      ${this.live && !this.error ? `<span class="live-pill" title="Updated in real time (kubectl watch)"><span class="live-dot"></span>Live</span>` : ""}
      ${this.error ? `<span class="error-pill" title="${esc(this.error)}">${codicon("warning")} ${esc(this.error.split("\n")[0])}</span>` : ""}
      ${isList && this.checked.size ? `<button type="button" class="button danger" ${data({ action: "delete-checked" })}>${codicon("trash")} Delete (${this.checked.size})</button>` : ""}
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

  private body(rows: Row[]): string {
    const spinner = `<div class="empty"><div class="spinner"></div></div>`;
    const v = this.view;
    if (!v) return spinner;
    if (v.mode === "overview") return this.overview ? renderOverview(this.overview, v.context, this.details?.uid) : spinner;
    if (this.loading && !this.rows.length) return spinner;
    if (this.error && !this.rows.length) return `<div class="empty error">${codicon("error")}<div>${esc(this.error)}</div></div>`;
    return renderTable({
      context: v.context,
      columns: v.columns,
      rows,
      selectedUid: this.ui.selected ? this.details?.uid : undefined,
      interactive: true,
      checked: this.checked,
      sort: this.ui.sort,
      empty: this.ui.search ? "No item matches the search" : "No item",
    });
  }

  render(): void {
    const active = document.activeElement as HTMLInputElement | null;
    const searchFocused = active?.id === "search";
    const caret = searchFocused ? active.selectionStart : null;
    const bodyEl = document.getElementById("r-body")!;
    const scroll = bodyEl.scrollTop;
    const drawerScroll = document.querySelector(".drawer-content")?.scrollTop ?? 0;

    const rows = this.visibleRows();
    this.region("r-header", this.header(rows));
    this.region("r-body", this.body(rows));
    this.renderDrawer();

    bodyEl.scrollTop = scroll;
    const drawerContent = document.querySelector(".drawer-content");
    if (drawerContent) drawerContent.scrollTop = drawerScroll;
    if (searchFocused) {
      const input = document.getElementById("search") as HTMLInputElement | null;
      input?.focus();
      if (caret !== null) input?.setSelectionRange(caret, caret);
    }
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
    this.region(
      "r-drawer-content",
      renderDrawerContent(this.details, {
        context: this.view?.context ?? "",
        error: this.detailsError,
        loading: this.detailsLoading,
        secrets: { values: this.secretValues, pending: this.secretPending, errors: this.secretErrors },
      }),
    );
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
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.uid === this.details?.uid);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))];
    this.history = [];
    this.showDetails(next.ref, false);
    document.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
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
      if (t.id !== "search") return;
      this.ui.search = t.value;
      this.save();
      this.render();
    });
    this.root.addEventListener("mousedown", (ev) => this.onDragStart(ev));
    window.addEventListener("keydown", (ev) => this.onKeyDown(ev));
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const inInput = (ev.target as HTMLElement).tagName === "INPUT";
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
      case "open-row":
        if (ref) this.showDetails(this.ui.selected && this.details?.uid === d.uid ? null : ref, false);
        return;
      case "open-ref":
        if (ref) this.showDetails(ref, true);
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
      case "delete-checked":
        this.post({ type: "deleteMany", refs: this.rows.filter((r) => this.checked.has(r.uid)).map((r) => r.ref) });
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
