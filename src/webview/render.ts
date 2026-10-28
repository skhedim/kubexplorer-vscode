// Renders cells, tables, the details drawer and the overview from the generic view model.

import type { RowMenuContext } from "../shared/protocol";
import { formatAge } from "../shared/units";
import type {
  ActionId,
  Cell,
  ClusterUsage,
  ColumnDef,
  OverviewCard,
  Details,
  DetailItem,
  DetailSection,
  Donut,
  OverviewData,
  ResourceRef,
  Row,
} from "../shared/view";
import { checkbox, codicon, data, esc } from "./dom";

export const ACTION_META: Record<ActionId, { icon: string; title: string }> = {
  logs: { icon: "output", title: "Logs" },
  shell: { icon: "terminal", title: "Shell" },
  debug: { icon: "debug", title: "Debug" },
  nodeShell: { icon: "terminal-linux", title: "Node Shell" },
  portForward: { icon: "plug", title: "Forward Port" },
  openBrowser: { icon: "link-external", title: "Open in Browser" },
  rollback: { icon: "discard", title: "Rollback" },
  values: { icon: "symbol-property", title: "Values" },
  manifest: { icon: "file-code", title: "Manifest" },
  install: { icon: "cloud-download", title: "Install" },
  stop: { icon: "debug-stop", title: "Stop" },
  scale: { icon: "arrow-both", title: "Scale" },
  restart: { icon: "debug-restart", title: "Restart" },
  trigger: { icon: "play", title: "Trigger Now" },
  reconcile: { icon: "sync", title: "Reconcile" },
  suspend: { icon: "debug-pause", title: "Suspend" },
  resume: { icon: "debug-continue", title: "Resume" },
  cordon: { icon: "circle-slash", title: "Cordon" },
  uncordon: { icon: "pass", title: "Uncordon" },
  drain: { icon: "clear-all", title: "Drain" },
  edit: { icon: "edit", title: "Edit YAML" },
  editDecoded: { icon: "unlock", title: "Edit Decoded Values" },
  describe: { icon: "info", title: "Describe" },
  copyName: { icon: "copy", title: "Copy Name" },
  delete: { icon: "trash", title: "Delete" },
};

function renderCell(cell: Cell | undefined): string {
  if (cell === undefined || cell === "") return "";
  if (typeof cell === "string") return `<span class="ellipsis" title="${esc(cell)}">${esc(cell)}</span>`;
  if ("bricks" in cell) {
    return `<span class="bricks">${cell.bricks.map((b) => `<span class="StatusBrick ${b.state}${b.init ? " init" : ""}" title="${esc(b.title)}"></span>`).join("")}</span>`;
  }
  if ("tags" in cell) {
    return `<span class="tags${cell.solid ? " solid" : ""}">${cell.tags
      .map((t) => `<span class="tag${t.tone ? ` tone-${t.tone}` : ""}" title="${esc(t.title ?? t.text)}">${esc(t.text)}</span>`)
      .join("")}</span>`;
  }
  if ("bar" in cell) {
    return `<span class="bar-cell" title="${esc(cell.title ?? cell.text)}"><span class="bar"><span class="bar-fill tone-bg-${cell.tone ?? "info"}" style="width:${Math.round(cell.bar * 100)}%"></span>${
      cell.marker !== undefined ? `<span class="bar-marker" style="left:${Math.round(Math.min(1, cell.marker) * 100)}%"></span>` : ""
    }</span><span class="bar-text">${esc(cell.text)}</span></span>`;
  }
  if ("link" in cell) {
    return `<span class="ellipsis">${cell.prefix ? esc(cell.prefix) : ""}<a href="#" class="link" title="${esc(cell.title ?? cell.link)}" ${data({ action: "open-ref", ref: cell.ref })}>${esc(cell.link)}</a></span>`;
  }
  if ("since" in cell) {
    const label = `${cell.prefix ?? ""}${formatAge(cell.since)}${cell.suffix ?? ""}`;
    return `<span class="ellipsis${cell.tone ? ` tone-${cell.tone}` : ""}" title="${esc(cell.title ?? cell.since)}">${esc(label)}</span>`;
  }
  const cls = ["ellipsis", cell.tone ? `tone-${cell.tone}` : "", cell.mono ? "mono" : ""].filter(Boolean).join(" ");
  return `<span class="${cls}" title="${esc(cell.title ?? cell.text)}">${esc(cell.text)}</span>`;
}

function colStyle(c: ColumnDef): string {
  return c.width ? `flex: 0 0 ${c.width}px` : `flex-grow: ${c.grow ?? 1}`;
}

export interface TableOptions {
  context: string;
  columns: ColumnDef[];
  rows: Row[];
  selectedUid?: string;
  /** Selection and menu columns (main list only). */
  interactive: boolean;
  checked?: Set<string>;
  sort?: { col: string; desc: boolean };
  empty: string;
}

function menuContext(context: string, row: Row): RowMenuContext {
  return {
    webviewSection: "row",
    preventDefaultContextMenuItems: true,
    kubexplorerContext: context,
    kubexplorerResource: row.ref.resource,
    kubexplorerNamespace: row.ref.namespace,
    kubexplorerName: row.ref.name,
    kubexplorerActions: row.actions.join(","),
  };
}

function tableHead(o: TableOptions): string {
  const head = o.columns
    .map((c) => {
      const sorted = o.sort?.col === c.id;
      const sortable = o.interactive && c.sortable !== false && c.title;
      const icon = sortable
        ? codicon(sorted && o.sort?.desc ? "arrow-up" : "arrow-down", { cls: `sort-icon${sorted ? " active" : ""}` })
        : "";
      const aria = sorted ? `aria-sort="${o.sort?.desc ? "descending" : "ascending"}"` : "";
      return `<div role="columnheader" class="cell col-${esc(c.id)}${sortable ? " sortable" : ""}" style="${colStyle(c)}" ${aria} ${sortable ? data({ action: "sort", col: c.id }) : ""}>${esc(c.title)}${icon}</div>`;
    })
    .join("");
  const allChecked = !!o.checked && o.rows.length > 0 && o.rows.every((r) => o.checked!.has(r.uid));
  return `
    <div role="row" class="row head" aria-rowindex="1">
      ${o.interactive ? `<div class="cell col-check">${checkbox(allChecked, "check-all", {}, "Select all")}</div>` : ""}
      ${head}
      ${o.interactive ? `<div class="cell col-menu"></div>` : ""}
    </div>`;
}

/** One row; `index` is its position in the whole table (stripes, accessibility). */
function tableRow(o: TableOptions, r: Row, index: number): string {
  const cells = o.columns
    .map((c) => {
      const content =
        c.id === "warning" ? (r.warning ? codicon("warning", { cls: "tone-warning", title: r.warning }) : "") : renderCell(r.cells[c.id]);
      return `<div role="cell" class="cell col-${esc(c.id)}" style="${colStyle(c)}">${content}</div>`;
    })
    .join("");
  const selected = o.selectedUid === r.uid;
  return `<div role="row" class="row${index % 2 ? "" : " stripe"}${selected ? " selected" : ""}" aria-rowindex="${index + 2}" aria-selected="${selected}" ${data({ action: "open-row", ref: r.ref, uid: r.uid })} ${
    o.interactive ? `data-vscode-context="${esc(JSON.stringify(menuContext(o.context, r)))}"` : ""
  }>${o.interactive ? `<div class="cell col-check">${checkbox(o.checked?.has(r.uid) ?? false, "check", { uid: r.uid })}</div>` : ""}${cells}${
    o.interactive
      ? `<div class="cell col-menu">${codicon("kebab-vertical", { action: "row-menu", title: "Actions", attrs: { ref: r.ref, actions: r.actions.join(",") } })}</div>`
      : ""
  }</div>`;
}

export function renderTable(o: TableOptions): string {
  const rows = o.rows.map((r, i) => tableRow(o, r, i)).join("");
  return `
  <div role="table" class="table${o.interactive ? " interactive" : ""}" aria-rowcount="${o.rows.length + 1}">
    ${tableHead(o)}
    ${rows || `<div class="empty">${esc(o.empty)}</div>`}
  </div>`;
}

/**
 * A table whose rows are rendered on demand (renderTableRows): only those in view are in the DOM, so that a list of
 * thousands of objects stays fluid. Rows have a fixed height (--kx-row-height); the sizer gives the scroll range.
 */
export function renderVirtualTable(o: TableOptions, windowId: string): string {
  const body = o.rows.length
    ? `<div class="table-sizer" style="height: calc(var(--kx-row-height) * ${o.rows.length})"><div class="table-window" id="${windowId}"></div></div>`
    : `<div class="empty">${esc(o.empty)}</div>`;
  return `
  <div role="table" class="table virtual${o.interactive ? " interactive" : ""}" aria-rowcount="${o.rows.length + 1}">
    ${tableHead(o)}
    ${body}
  </div>`;
}

/** The rows [start, end) of a virtual table. */
export function renderTableRows(o: TableOptions, start: number, end: number): string {
  let html = "";
  for (let i = start; i < end; i++) html += tableRow(o, o.rows[i], i);
  return html;
}

// ---------- Drawer ----------

function renderValue(item: DetailItem): string {
  const values = Array.isArray(item.value) ? item.value : [item.value];
  if (item.block)
    return values.map((v) => `<pre class="block">${esc(typeof v === "string" ? v : "text" in v ? v.text : "")}</pre>`).join("");
  const rendered = values.map(renderCell).filter(Boolean);
  if (!rendered.length) return `<span class="dim">—</span>`;
  return Array.isArray(item.value) && values.every((v) => typeof v === "string" || "text" in v)
    ? rendered.map((r) => `<div>${r}</div>`).join("")
    : rendered.join(" ");
}

/** Secret values revealed or edited by the user for the object shown in the drawer (kept in memory only). */
export interface SecretView {
  ref: ResourceRef;
  values: ReadonlyMap<string, string>;
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  /** Values being edited (draft per key), and those being saved. */
  drafts: ReadonlyMap<string, string>;
  saving: ReadonlySet<string>;
  /** false on a read-only context. */
  editable: boolean;
}

/** A value edited in place: Ctrl+Enter saves, Escape cancels. */
function renderSecretEditor(item: DetailItem, key: string, draft: string, secrets: SecretView): string {
  const saving = secrets.saving.has(key);
  const error = secrets.errors.get(key);
  const rows = Math.min(12, Math.max(1, draft.split("\n").length));
  // Empty: the app sets the value (the draft) through the DOM, so typing never changes this HTML.
  const editor = `<textarea class="secret-editor" data-key="${esc(key)}" rows="${rows}" spellcheck="false" aria-label="Value of ${esc(key)}"${saving ? " disabled" : ""}></textarea>`;
  const actions =
    codicon("check", {
      action: "save-secret",
      title: "Save (Ctrl+Enter)",
      cls: saving ? "pending" : undefined,
      attrs: { key, ref: secrets.ref },
    }) + codicon("close", { action: "cancel-secret", title: "Cancel (Escape)", attrs: { key } });
  const note = error
    ? `<span class="tone-error">${esc(error)}</span>`
    : `<span class="secret-hint">Ctrl+Enter to save · Escape to cancel</span>`;
  return `<div class="drawer-item secret-item editing"><span class="name">${esc(item.name)}</span><span class="value"><span class="secret-body">${editor}${note}</span><span class="secret-actions">${actions}</span></span></div>`;
}

function renderSecret(item: DetailItem, key: string, secrets: SecretView): string {
  const draft = secrets.drafts.get(key);
  if (draft !== undefined) return renderSecretEditor(item, key, draft, secrets);
  const value = secrets.values.get(key);
  const revealed = value !== undefined;
  const toggle = codicon(revealed ? "eye-closed" : "eye", {
    action: "toggle-secret",
    title: revealed ? "Hide value" : "Reveal value",
    cls: secrets.pending.has(key) ? "pending" : undefined,
    attrs: { key, ref: secrets.ref },
  });
  const copy = revealed ? codicon("copy", { action: "copy-secret", title: "Copy value", attrs: { key } }) : "";
  const editButton = secrets.editable
    ? codicon("edit", { action: "edit-secret", title: "Edit value", attrs: { key, ref: secrets.ref } })
    : "";
  const error = secrets.errors.get(key);
  const body = revealed
    ? `<pre class="block secret-value">${esc(value)}</pre>`
    : `<span class="secret-mask" aria-label="Hidden value">••••••••</span> ${renderValue(item)}${error ? ` <span class="tone-error">${esc(error)}</span>` : ""}`;
  return `<div class="drawer-item secret-item"><span class="name">${esc(item.name)}</span><span class="value"><span class="secret-body">${body}</span><span class="secret-actions">${toggle}${copy}${editButton}</span></span></div>`;
}

function renderItems(items: DetailItem[], secrets?: SecretView): string {
  return items
    .map((i) =>
      i.secretKey && secrets
        ? renderSecret(i, i.secretKey, secrets)
        : `<div class="drawer-item${i.block ? " block-item" : ""}"><span class="name">${esc(i.name)}</span><span class="value">${renderValue(i)}</span></div>`,
    )
    .join("");
}

function renderSection(s: DetailSection, context: string, ref: ResourceRef, secrets?: SecretView): string {
  switch (s.type) {
    case "items":
      return renderItems(s.items, secrets);
    case "title":
      return `<div class="drawer-subtitle">${esc(s.text)}</div>`;
    case "group":
      return `
      <div class="drawer-group">
        <div class="group-title">
          ${s.brick ? `<span class="StatusBrick ${s.brick}"></span>` : ""}
          <span class="group-name">${esc(s.title)}</span>
          ${s.badge ? `<span class="tag">${esc(s.badge)}</span>` : ""}
          <span class="spacer"></span>
          ${(s.actions ?? []).map((a) => codicon(ACTION_META[a.action].icon, { action: "action", title: `${ACTION_META[a.action].title} (${a.container})`, attrs: { act: a.action, ref, container: a.container } })).join("")}
        </div>
        ${renderItems(s.items)}
      </div>`;
    case "table":
      return renderTable({ context, columns: s.columns, rows: s.rows, interactive: false, empty: s.empty });
    case "grid":
      return renderGrid(s.columns, s.rows, s.empty);
    case "metrics":
      // Filled by the "metrics" message (renderMetrics), loaded after the details.
      return `<div id="r-drawer-metrics" class="drawer-metrics"></div>`;
  }
}

/** A read-only table of cells (conditions, inventory…): its rows are not objects. */
function renderGrid(columns: ColumnDef[], rows: Cell[][], empty: string): string {
  const head = columns.map((c) => `<div role="columnheader" class="cell" style="${colStyle(c)}">${esc(c.title)}</div>`).join("");
  const body = rows
    .map(
      (r, n) =>
        `<div role="row" class="row${n % 2 ? "" : " stripe"}">${columns.map((c, i) => `<div role="cell" class="cell" style="${colStyle(c)}">${renderCell(r[i])}</div>`).join("")}</div>`,
    )
    .join("");
  return `<div role="table" class="table grid"><div role="row" class="row head">${head}</div>${body || `<div class="empty">${esc(empty)}</div>`}</div>`;
}

const DRAWER_ACTIONS: ActionId[] = [
  "logs",
  "shell",
  "debug",
  "nodeShell",
  "portForward",
  "openBrowser",
  "scale",
  "restart",
  "trigger",
  "reconcile",
  "suspend",
  "resume",
  "cordon",
  "uncordon",
  "drain",
  "values",
  "manifest",
  "rollback",
  "install",
  "edit",
  "editDecoded",
  "stop",
  "delete",
];

export interface DrawerOptions {
  context: string;
  error?: string;
  loading: boolean;
  secrets: Omit<SecretView, "ref">;
}

/**
 * The drawer frame, created once when the drawer opens. Its header and content are then updated in
 * place (renderDrawerHeader, renderDrawerContent): recreating the frame would replay its opening
 * animation on every refresh.
 */
export function renderDrawerFrame(width: number): string {
  return `
  <aside class="drawer" style="--drawer-width:${width}px" aria-label="Details">
    <div class="drawer-resizer" data-drag="drawer" title="Resize"></div>
    <header class="drawer-title" id="r-drawer-header"></header>
    <div class="drawer-content" id="r-drawer-content"></div>
  </aside>`;
}

export function renderDrawerHeader(d: Details | null, canGoBack: boolean): string {
  const actions = d ? DRAWER_ACTIONS.filter((a) => d.actions.includes(a)) : [];
  return `
    ${canGoBack ? codicon("arrow-left", { action: "details-back", title: "Back" }) : ""}
    <h2>${esc(d?.title ?? "")}</h2>
    <div class="toolbar">
      ${d ? actions.map((a) => codicon(ACTION_META[a].icon, { action: "action", title: ACTION_META[a].title, attrs: { act: a, ref: d.ref } })).join("") : ""}
      ${codicon("close", { action: "close-drawer", title: "Close (Escape)" })}
    </div>`;
}

export function renderDrawerContent(d: Details | null, opts: DrawerOptions): string {
  if (!d) {
    if (opts.error) return `<div class="empty error">${codicon("error")} ${esc(opts.error)}</div>`;
    return opts.loading ? `<div class="empty"><div class="spinner"></div></div>` : `<div class="empty">This object no longer exists.</div>`;
  }
  const secrets: SecretView = { ref: d.ref, ...opts.secrets };
  return d.sections.map((s) => renderSection(s, opts.context, d.ref, secrets)).join("");
}

// ---------- Overview ----------

function donut(d: Donut): string {
  const total = d.slices.reduce((n, s) => n + s.value, 0);
  const r = 54;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = d.slices
    .map((s) => {
      const len = (s.value / total) * circ;
      const arc = `<circle class="arc ${s.color !== undefined ? `cat-stroke-${s.color}` : `tone-stroke-${s.tone}`}" r="${r}" cx="70" cy="70" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}"><title>${esc(s.label)} : ${s.value}</title></circle>`;
      offset += len;
      return arc;
    })
    .join("");
  return `
  <div class="workload">
    <a href="#" class="link workload-title" ${data({ action: "open-resource", resource: d.resource })}>${esc(d.title)} (${total})</a>
    <svg class="donut" viewBox="0 0 140 140" width="132" height="132" role="img" aria-label="${esc(d.title)}">
      <g transform="rotate(-90 70 70)"><circle class="track" r="${r}" cx="70" cy="70"/>${arcs}</g>
      <text x="70" y="70" class="donut-total">${d.error ? "!" : total}</text>
    </svg>
    <div class="legend">
      ${d.error ? `<div class="tone-error" title="${esc(d.error)}">unavailable</div>` : d.slices.map((s) => `<div><span class="dot ${s.color !== undefined ? `cat-bg-${s.color}` : `tone-bg-${s.tone}`}"></span>${esc(s.label)}: ${s.value}</div>`).join("") || `<div class="dim">—</div>`}
    </div>
  </div>`;
}

function gauge(title: string, g: { usage: number; requests: number; text: string } | undefined): string {
  if (!g) return "";
  const pct = Math.round(g.usage * 100);
  const tone = g.usage >= 0.9 ? "error" : g.usage >= 0.75 ? "warning" : "ok";
  return `
  <div class="gauge">
    <div class="gauge-head"><span class="gauge-title">${esc(title)}</span><span class="gauge-pct tone-${tone}">${pct}%</span></div>
    <div class="bar big" title="Usage ${pct}% · requests ${Math.round(g.requests * 100)}%">
      <span class="bar-fill tone-bg-${tone}" style="width:${Math.min(100, pct)}%"></span>
      <span class="bar-marker" style="left:${Math.min(100, Math.round(g.requests * 100))}%" title="Requests"></span>
    </div>
    <div class="gauge-text dim">${esc(g.text)}</div>
  </div>`;
}

function usageSection(u: ClusterUsage | undefined): string {
  if (!u) return "";
  return `
  <section class="overview-usage">
    ${gauge("CPU", u.cpu)}
    ${gauge("Memory", u.memory)}
    <div class="gauge">
      <div class="gauge-head"><span class="gauge-title">Pods</span><span class="gauge-pct">${u.pods.count} / ${u.pods.capacity}</span></div>
      <div class="bar big"><span class="bar-fill tone-bg-info" style="width:${u.pods.capacity ? Math.min(100, Math.round((u.pods.count / u.pods.capacity) * 100)) : 0}%"></span></div>
      <div class="gauge-text dim">running pods / node capacity</div>
    </div>
    ${u.error ? `<div class="gauge-error tone-warning">${codicon("info")} ${esc(u.error)}</div>` : ""}
  </section>`;
}

function card(c: OverviewCard): string {
  return `
  <div class="overview-card">
    <div class="card-title">
      ${c.ref ? `<a href="#" class="link" ${data({ action: "open-ref", ref: c.ref })}>${esc(c.title)}</a>` : esc(c.title)}
      <span class="spacer"></span>
      ${c.tag ? renderCell({ tags: [c.tag], solid: true }) : ""}
    </div>
    ${renderItems(c.items)}
  </div>`;
}

export function renderOverview(o: OverviewData, context: string, selectedUid?: string): string {
  if (o.empty) return `<div class="empty">${codicon("info")}<div>${esc(o.empty)}</div></div>`;
  return `
  ${usageSection(o.usage)}
  ${o.cards?.length ? `<section class="overview-cards">${o.cards.map(card).join("")}</section>` : ""}
  ${o.donuts.length ? `<section class="overview-statuses">${o.donuts.map(donut).join("")}</section>` : ""}
  ${o.tables
    .map(
      (t) => `
  <section class="overview-table">
    <h3>${t.icon ? codicon(t.icon, { cls: t.icon === "warning" ? "tone-warning" : undefined }) : ""} ${esc(t.title)} <span class="dim">(${t.rows.length})</span></h3>
    ${renderTable({ context, columns: t.columns, rows: t.rows, interactive: false, selectedUid, empty: t.empty })}
  </section>`,
    )
    .join("")}`;
}
