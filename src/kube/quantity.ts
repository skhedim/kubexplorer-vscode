// Kubernetes quantities (resource.Quantity): CPU in millicores, memory in bytes.

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const QUANTITY = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/;

/** Numeric value of a quantity ("250m" -> 0.25, "16Ki" -> 16384, "1e3" -> 1000), NaN when unreadable. */
export function parseQuantity(q: string | number | undefined): number {
  if (q === undefined || q === "") return NaN;
  if (typeof q === "number") return q;
  const m = QUANTITY.exec(q.trim());
  if (!m) return NaN;
  const factor = BINARY[m[2]] ?? DECIMAL[m[2]];
  return factor === undefined ? NaN : Number(m[1]) * factor;
}

export const cpuMillis = (q: string | number | undefined): number => parseQuantity(q) * 1000;
export const memoryBytes = (q: string | number | undefined): number => parseQuantity(q);

/** 0.02 -> "<1m", 250 -> "250m", 1500 -> "1.50" (millicores below one core, like Freelens). */
export function formatCpu(millis: number): string {
  if (!Number.isFinite(millis)) return "";
  if (millis < 1) return millis > 0 ? "<1m" : "0";
  return millis < 1000 ? `${Math.round(millis)}m` : (millis / 1000).toFixed(2);
}

export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)}Gi`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)}Mi`;
  return `${Math.round(bytes / 2 ** 10)}Ki`;
}
