// The pieces of the header of a tab: the namespace filter, the protection pill, the bar of actions on the checked rows,
// and the header of the Fleet tab (groups, tabs, search, its status). Pure functions of the state of the App.

import type { Protection } from "../shared/protection";
import type { NamespaceFilter } from "../shared/protocol";
import { BULK_ACTIONS, type FleetTab, type FleetView, type OverviewData, type Row } from "../shared/view";
import { checkbox, codicon, data, esc } from "./dom";
import { ACTION_META } from "./render";

export function namespaceSelect(ns: NamespaceFilter, open: boolean): string {
  const sel = ns.selected;
  const label = sel.length === 0 ? "All namespaces" : sel.length <= 2 ? sel.join(", ") : `${sel.length} namespaces`;
  const options = [
    `<div role="option" class="option" aria-selected="${sel.length === 0}" ${data({ action: "ns-all" })}>${checkbox(sel.length === 0, "ns-all")}<span>All namespaces</span></div>`,
    ...ns.available.map(
      (n) =>
        `<div role="option" class="option" aria-selected="${sel.includes(n)}" ${data({ action: "ns-toggle", ns: n })}>${checkbox(sel.includes(n), "ns-toggle", { ns: n })}<span>${esc(n)}</span></div>`,
    ),
  ].join("");
  return `
    <div class="ns-select${open ? " open" : ""}">
      <button type="button" class="select-control" ${data({ action: "ns-menu" })} aria-haspopup="listbox" aria-expanded="${open}" title="Filter namespaces">
        ${codicon("layers")}<span class="select-value">${esc(label)}</span>${codicon("chevron-down")}
      </button>
      ${open ? `<div class="select-menu" role="listbox" aria-multiselectable="true">${options}</div>` : ""}
    </div>`;
}

/** A protected context: a pill in the header (the tab is framed by the CSS). */
export function protectionPill(protection: Protection, context: string): string {
  if (protection === "none") return "";
  const readOnly = protection === "readOnly";
  const title = readOnly
    ? `${context} is read-only: the actions that change the cluster are disabled (kubexplorer.protectedContexts)`
    : `${context} is protected: every change asks you to type the name of its target (kubexplorer.protectedContexts)`;
  return `<span class="protected-pill" title="${esc(title)}">${codicon(readOnly ? "lock" : "shield")} ${readOnly ? "Read-only" : "Protected"}</span>`;
}

/** Actions on the checked rows: those every checked row supports. */
export function bulkBar(checked: Row[]): string {
  if (!checked.length) return "";
  const actions = BULK_ACTIONS.filter((a) => checked.every((r) => r.actions.includes(a)));
  const buttons = actions
    .map(
      (a) =>
        `<button type="button" class="button${a === "delete" ? " danger" : ""}" ${data({ action: "bulk", act: a })}>${codicon(ACTION_META[a].icon)} ${esc(ACTION_META[a].title)}</button>`,
    )
    .join("");
  return `<span class="bulk-bar" role="toolbar" aria-label="Actions on the selected items"><span class="bulk-count">${checked.length} selected</span>${buttons}${codicon("close", { action: "uncheck-all", title: "Clear selection" })}</span>`;
}

const FLEET_TABS: [FleetTab, string, string][] = [
  ["clusters", "server-environment", "Clusters"],
  ["flux", "sync", "Flux"],
  ["diagnostics", "checklist", "Diagnostics"],
  ["search", "search", "Search"],
];

/** The header of the Fleet tab; its status (r-fleet-status) is a region of its own (fleetStatus). */
export function fleetHeader(f: FleetView | undefined, title: string, search: string): string {
  if (!f) return `<div class="title-row"><h1>Fleet</h1></div>`;
  const chip = (label: string, active: boolean, attrs: Record<string, unknown>, tip?: string) =>
    `<button type="button" class="chip${active ? " active" : ""}" aria-pressed="${active}"${tip ? ` title="${esc(tip)}"` : ""} ${data(attrs)}>${label}</button>`;
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
      <h1>${esc(title)}</h1>
      <span class="count" id="r-fleet-status"></span>
      <span class="spacer"></span>
      ${groups}
      ${f.tab !== "search" ? chip(`${codicon("warning")} Problems only`, f.problemsOnly, { action: "fleet-problems" }, "Only the clusters or objects with a problem") : ""}
      ${kinds}
      <label class="search">${codicon("search")}<input id="search" type="text" placeholder="${esc(placeholder)}" value="${esc(search)}" spellcheck="false" aria-label="${searchTab ? "Search the clusters" : "Filter"}">${
        search ? codicon("close", { action: "clear-search", title: "Clear" }) : ""
      }</label>
      ${run}
      ${codicon("export", { action: "fleet-run", title: "Export a report (Markdown) of the clusters shown", attrs: { what: "export" } })}
      ${codicon("refresh", { action: "fleet-run", title: "Scan the clusters now", attrs: { what: "scan" } })}
    </div>
    <div class="fleet-tabs" role="tablist">${FLEET_TABS.map(
      ([id, icon, label]) =>
        `<button type="button" role="tab" class="fleet-tab${f.tab === id ? " active" : ""}" aria-selected="${f.tab === id}" ${data({ action: "fleet-tab", tab: id })}>${codicon(icon)} ${label}</button>`,
    ).join("")}</div>`;
}

/** Clusters shown, and the scan, diagnostics or search in progress (or when the clusters were scanned). */
export function fleetStatus(f: FleetView | undefined): string {
  if (!f) return "";
  const progress = f.progress
    ? ` · <span class="spinner small"></span> ${esc(f.progress.label)} ${f.progress.done}/${f.progress.total}`
    : f.updated
      ? ` · ${esc(f.updated)}`
      : "";
  return `${f.clusters} ${f.clusters === 1 ? "cluster" : "clusters"}${progress}`;
}

/** The data of a Fleet tab, its rows filtered by the text of the search box (but on the Search tab). */
export function fleetData(f: FleetView, search: string): OverviewData {
  const terms = f.tab === "search" ? [] : search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return f.data;
  return {
    ...f.data,
    tables: f.data.tables.map((t) => ({ ...t, rows: t.rows.filter((r) => terms.every((term) => r.search.includes(term))) })),
  };
}
