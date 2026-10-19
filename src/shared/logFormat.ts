// ANSI coloring of log lines for the VS Code terminal. Pure module, unit tested.

export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
/** Colors of the [pod/name/container] prefixes: cyan, green, magenta, blue and their bright variants (not red nor yellow). */
const PREFIX_COLORS = [36, 32, 35, 34, 96, 92, 95, 94].map((c) => `\x1b[${c}m`);

/** A stable color per prefix, so that the lines of each pod of a workload stand out. */
function prefixColor(prefix: string): string {
  let hash = 0;
  for (const c of prefix) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return PREFIX_COLORS[hash % PREFIX_COLORS.length];
}

/** Optional "[pod/name/container] " prefix (--prefix), then the RFC 3339 timestamp (--timestamps). */
const HEADER = /^(\[[^\]]+\] )?(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /;
const ERROR = /level=(error|fatal)|\bERROR\b|\bpanic\b|\bFATAL\b/i;
const WARNING = /level=warn|\bWARN(ING)?\b/i;

/** Colors a log line: prefix in its own color, dimmed timestamp, errors in red, warnings in yellow. */
export function colorizeLogLine(line: string): string {
  let prefix = "";
  let timestamp = "";
  let rest = line;
  const m = HEADER.exec(line);
  if (m) {
    prefix = m[1] ? `${prefixColor(m[1])}${m[1]}${RESET}` : "";
    timestamp = `${DIM}${m[2]}${RESET} `;
    rest = line.slice(m[0].length);
  }
  if (ERROR.test(rest)) rest = `${RED}${rest}${RESET}`;
  else if (WARNING.test(rest)) rest = `${YELLOW}${rest}${RESET}`;
  return prefix + timestamp + rest;
}
