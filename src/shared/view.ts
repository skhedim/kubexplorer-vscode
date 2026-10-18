// Generic view model sent to the webview. The webview knows nothing about Kubernetes:
// it renders columns, typed cells and detail sections.

/** Semantic tone, turned into a color by the theme (green = ok, orange = warning…). */
export type Tone = "ok" | "success" | "info" | "warning" | "error" | "muted" | "terminated";

export type ContainerState = "running" | "restarted" | "waiting" | "terminated" | "failed";

/** Reference to a cluster object (used by links and actions). */
export interface ResourceRef {
  /** Resource type identifier (registry key, e.g. "pods", "deployments"). */
  resource: string;
  namespace?: string;
  name: string;
}

export interface Brick {
  state: ContainerState;
  title: string;
  init?: boolean;
}

export interface Tag {
  text: string;
  tone?: Tone;
  title?: string;
}

export type Cell =
  | string
  | { text: string; tone?: Tone; title?: string; mono?: boolean }
  | { bricks: Brick[] }
  | { tags: Tag[]; solid?: boolean }
  | { link: string; ref: ResourceRef; title?: string; prefix?: string }
  /** Gauge (Freelens LineProgress): 0..1 ratio, text next to it, optional marker (e.g. requests). */
  | { bar: number; text: string; tone?: Tone; marker?: number; title?: string };

export interface ColumnDef {
  id: string;
  title: string;
  /** flex-grow weight, like Freelens columns. */
  grow?: number;
  /** Fixed width in px (takes precedence over grow). */
  width?: number;
  sortable?: boolean;
}

/** Every action; each one has a `kubexplorer.resource.<action>` command (package.json). */
export const ALL_ACTIONS = [
  "logs",
  "shell",
  "portForward",
  "openBrowser",
  "scale",
  "restart",
  "trigger",
  "reconcile",
  "suspend",
  "resume",
  "rollback",
  "values",
  "manifest",
  "install",
  "edit",
  "describe",
  "copyName",
  "stop",
  "delete",
] as const;

export type ActionId = (typeof ALL_ACTIONS)[number];

export interface Row {
  uid: string;
  ref: ResourceRef;
  cells: Record<string, Cell>;
  /** Sort keys per column (when missing, the cell text is used). */
  sort: Record<string, string | number>;
  /** Lowercase text matched by the search box. */
  search: string;
  /** Warning shown as an icon in the dedicated column. */
  warning?: string;
  actions: ActionId[];
}

export interface DetailItem {
  name: string;
  value: Cell | Cell[];
  /** Long value shown as a monospace block (ConfigMap data, etc.). */
  block?: boolean;
  /**
   * Key of a Secret value: the value itself is never part of the view model. The webview shows it
   * masked, with a reveal button that asks the extension for this one value.
   */
  secretKey?: string;
}

export type DetailSection =
  | { type: "items"; items: DetailItem[] }
  | { type: "title"; text: string }
  | {
      type: "group";
      title: string;
      brick?: ContainerState;
      badge?: string;
      /** Actions on a sub-element (e.g. the logs of one container). */
      actions?: { action: ActionId; container: string }[];
      items: DetailItem[];
    }
  | { type: "table"; columns: ColumnDef[]; rows: Row[]; empty: string }
  /** A plain table, whose rows are not objects (conditions, inventory, history…). */
  | { type: "grid"; columns: ColumnDef[]; rows: Cell[][]; empty: string }
  /** Usage charts over time: a placeholder, filled by the "metrics" message (loaded separately). */
  | { type: "metrics" };

export interface Details {
  uid: string;
  ref: ResourceRef;
  kindName: string;
  title: string;
  actions: ActionId[];
  sections: DetailSection[];
}

// ---------- Metric charts ----------

export type ChartUnit = "cpu" | "bytes" | "bytesPerSecond";

/** usage: the measured series (an area); secondary: a second measured series; the others are reference lines. */
export type SeriesRole = "usage" | "secondary" | "requests" | "limits" | "capacity";

export interface ChartSeries {
  label: string;
  role: SeriesRole;
  /** [unix seconds, value] points; a reference line has one constant value instead. */
  points?: [number, number][];
  value?: number;
}

export interface Chart {
  id: string;
  title: string;
  unit: ChartUnit;
  series: ChartSeries[];
}

export interface MetricsData {
  /** Where the values come from, shown under the charts. */
  source: string;
  charts: Chart[];
  /** Why there is no or little data (e.g. metrics collected since the tab opened). */
  note?: string;
  error?: string;
}

// ---------- Overview ----------

export interface DonutSlice {
  label: string;
  value: number;
  tone: Tone;
  /** Index in the categorical palette, for slices that are categories rather than states (zones, types…). */
  color?: number;
}

export interface Donut {
  title: string;
  resource: string;
  slices: DonutSlice[];
  error?: string;
}

export interface ClusterUsage {
  /** 0..1 ratios of the allocatable capacity; missing when metrics-server is unavailable. */
  cpu?: { usage: number; requests: number; text: string };
  memory?: { usage: number; requests: number; text: string };
  pods: { count: number; capacity: number };
  error?: string;
}

/** A summary card (e.g. a Karpenter NodePool): a title linking to the object, and detail items. */
export interface OverviewCard {
  title: string;
  ref?: ResourceRef;
  tag?: Tag;
  items: DetailItem[];
}

export interface OverviewTable {
  title: string;
  icon?: string;
  columns: ColumnDef[];
  rows: Row[];
  empty: string;
}

export interface OverviewData {
  usage?: ClusterUsage;
  cards?: OverviewCard[];
  donuts: Donut[];
  /** Tables after the donuts, the last one being the events. */
  tables: OverviewTable[];
  /** Shown instead of the content when the page has nothing to show (e.g. Flux is not installed). */
  empty?: string;
}
