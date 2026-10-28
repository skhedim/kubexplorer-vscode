// Protected contexts (e.g. production): which actions they allow, and how they are matched.
// Pure module, shared by the extension (confirmations) and the panel controller (hidden actions).

import type { ActionId } from "./view";

/**
 * none: an ordinary context.
 * confirm: every change asks to type the name of its target.
 * readOnly: changes are refused, and their actions hidden.
 */
export type Protection = "none" | "confirm" | "readOnly";

export type ProtectionMode = Exclude<Protection, "none">;

/** Actions that change the cluster. */
export const WRITE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  "scale",
  "restart",
  "trigger",
  "reconcile",
  "suspend",
  "resume",
  "cordon",
  "uncordon",
  "drain",
  "rollback",
  "install",
  "debug",
  // A privileged pod: root on the node.
  "nodeShell",
  "delete",
]);

/** Actions refused on read-only contexts: changes, and shells (which can change anything). */
const READ_ONLY_DENIED: ReadonlySet<ActionId> = new Set<ActionId>([...WRITE_ACTIONS, "shell"]);

export function isAllowed(action: ActionId, protection: Protection): boolean {
  return protection !== "readOnly" || !READ_ONLY_DENIED.has(action);
}

export function allowedActions<T extends ActionId>(actions: T[], protection: Protection): T[] {
  return protection === "readOnly" ? actions.filter((a) => isAllowed(a, protection)) : actions;
}

/** Glob match, case insensitive: `*` matches any text, `?` one character. */
export function globMatch(pattern: string, text: string): boolean {
  const source = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "i").test(text);
}

/** The protection of a context: the mode when one of the patterns matches its name. */
export function contextProtection(context: string, patterns: readonly string[], mode: ProtectionMode): Protection {
  return patterns.some((p) => p.trim() && globMatch(p.trim(), context)) ? mode : "none";
}
