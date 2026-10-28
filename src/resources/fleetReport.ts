// The fleet as a Markdown report (Export Report in the Fleet tab): what the tab shows, as tables that paste into an
// issue, a merge request or a wiki. Built from the same tables as the tab. Pure module, unit tested.

import { formatAge } from "../shared/units";
import type { Cell, OverviewTable } from "../shared/view";
import type { ClusterScan, MatrixRow } from "./fleet";
import { clustersData, diagnosticsData, fluxData } from "./fleetViews";

/** The text of a cell, as the tab shows it. */
function cellText(cell: Cell | undefined, now: number): string {
  if (cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if ("since" in cell) return `${cell.prefix ?? ""}${formatAge(cell.since, now)}${cell.suffix ?? ""}`;
  if ("text" in cell) return cell.text;
  if ("link" in cell) return `${cell.prefix ?? ""}${cell.link}`;
  if ("tags" in cell) return cell.tags.map((t) => t.text).join(", ");
  return "";
}

const escape = (text: string) =>
  text
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();

/** A table of the tab as a Markdown table (columns without a title left out). */
function markdownTable(table: OverviewTable, now: number): string {
  const columns = table.columns.filter((c) => c.title);
  if (!table.rows.length) return `_${table.empty}_`;
  const head = `| ${columns.map((c) => escape(c.title)).join(" | ")} |\n|${columns.map(() => " --- |").join("")}`;
  const rows = table.rows.map((r) => `| ${columns.map((c) => escape(cellText(r.cells[c.id], now)) || " ").join(" | ")} |`);
  return [head, ...rows].join("\n");
}

export interface ReportInput {
  title: string;
  scans: ClusterScan[];
  /** The Flux matrix of these clusters, rollouts told apart. */
  rows: MatrixRow[];
  groups: string[];
  now: number;
}

export function fleetReport(input: ReportInput): string {
  const { scans, rows, now } = input;
  const reachable = scans.filter((s) => s.status === "ok").length;
  const unreachable = scans.filter((s) => s.status === "error");
  const checks = scans.map((s) => s.checkedAt).filter((c): c is number => c !== undefined);
  const scanned = checks.length ? `, scanned ${formatAge(new Date(Math.min(...checks)).toISOString(), now)} ago` : "";
  const out = [
    `# ${input.title}`,
    "",
    `${new Date(now).toISOString().replace("T", " ").slice(0, 16)} UTC · ${scans.length} clusters: ${reachable} reachable, ${unreachable.length} unreachable${scanned}.`,
    "",
    "## Clusters",
    "",
    markdownTable(clustersData(scans, input.groups, false, now).tables[0], now),
  ];
  // Failing and drifting objects, then the rollouts in progress.
  const flux = fluxData(
    rows.filter((r) => r.tone !== "ok"),
    scans,
    false,
  ).tables[0];
  out.push(
    "",
    "## Flux: failing, drifting and rolling out",
    "",
    markdownTable({ ...flux, empty: "Every Flux object is ready and the same everywhere." }, now),
  );
  if (scans.some((s) => s.diagnostics))
    for (const table of diagnosticsData(scans, true, now).tables)
      out.push("", `## Diagnostics: ${table.title}`, "", markdownTable(table, now));
  if (unreachable.length)
    out.push("", "## Unreachable clusters", "", ...unreachable.map((s) => `- ${s.context}: ${escape(s.error ?? "")}`));
  return `${out.join("\n")}\n`;
}
