// HTML rendering helpers of the webview.

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escaped data-* attributes. Objects are serialized as JSON (data-ref, data-vscode-context). */
export function data(attrs: Record<string, unknown>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `data-${k}="${esc(typeof v === "object" ? JSON.stringify(v) : v)}"`)
    .join(" ");
}

/** A VS Code codicon; with an action, it becomes an accessible button. */
export function codicon(
  name: string,
  opts: { action?: string; title?: string; cls?: string; attrs?: Record<string, unknown> } = {},
): string {
  const cls = `codicon codicon-${name}${opts.cls ? ` ${opts.cls}` : ""}`;
  if (!opts.action) return `<i class="${cls}" aria-hidden="true"${opts.title ? ` title="${esc(opts.title)}"` : ""}></i>`;
  return `<button type="button" class="icon-button" title="${esc(opts.title)}" aria-label="${esc(opts.title)}" ${data({ action: opts.action, ...opts.attrs })}><i class="${cls}" aria-hidden="true"></i></button>`;
}

export function checkbox(checked: boolean, action: string, attrs: Record<string, unknown> = {}, label = "Select"): string {
  return `<span role="checkbox" tabindex="-1" aria-checked="${checked}" aria-label="${esc(label)}" class="check ${checked ? "checked" : ""}" ${data({ action, ...attrs })}>${checked ? codicon("check") : ""}</span>`;
}
