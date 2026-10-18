// ANSI coloring of log lines for the VS Code terminal. Pure module, unit tested.

export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

/** Optional "[pod/name/container] " prefix (--prefix), then the RFC 3339 timestamp (--timestamps). */
const HEADER = /^(\[[^\]]+\] )?(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /;
const ERROR = /level=(error|fatal)|\bERROR\b|\bpanic\b|\bFATAL\b/i;
const WARNING = /level=warn|\bWARN(ING)?\b/i;

/** Colors a log line: container prefix in cyan, dimmed timestamp, errors in red, warnings in yellow. */
export function colorizeLogLine(line: string): string {
  let prefix = "";
  let timestamp = "";
  let rest = line;
  const m = HEADER.exec(line);
  if (m) {
    prefix = m[1] ? `${CYAN}${m[1]}${RESET}` : "";
    timestamp = `${DIM}${m[2]}${RESET} `;
    rest = line.slice(m[0].length);
  }
  if (ERROR.test(rest)) rest = `${RED}${rest}${RESET}`;
  else if (WARNING.test(rest)) rest = `${YELLOW}${rest}${RESET}`;
  return prefix + timestamp + rest;
}
