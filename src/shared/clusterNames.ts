// Pure helpers about context names: cluster avatars (like the Freelens hotbar) and short tab titles.

/** Initials of a context: "gke_project_zone_prod-1" -> "P1", "kind-kubexplorer" -> "KK". */
export function contextInitials(name: string): string {
  const short = name.includes("_") ? name.split("_").pop()! : name;
  const parts = short.split(/[-_.\s/]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

/** Short name for tab titles: "gke_project_zone_prod-1" -> "prod-1". */
export function shortContextName(name: string): string {
  const short = name.includes("_") ? name.split("_").pop()! : name;
  return short.length > 24 ? `${short.slice(0, 23)}…` : short;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Color derived from the name: stable across sessions, distinct between clusters. */
export function contextColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hslToHex(hash % 360, 45, 42);
}

/** 16x16 colored avatar with the context initials. */
export function avatarSvg(name: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${contextColor(name)}"/>` +
    `<text x="8" y="11.2" font-family="Segoe UI,Arial,sans-serif" font-size="7.5" font-weight="600" fill="#fff" text-anchor="middle">${contextInitials(name)}</text></svg>`
  );
}
