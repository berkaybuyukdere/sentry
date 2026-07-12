/** Shared numeric/string formatters — single source of truth for the terminal's data rendering. */

export function usd(n: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const sign = opts.sign && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  if (opts.compact !== false) {
    if (abs >= 1_000_000_000) return `${sign}$${(n / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(n / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000) return `${sign}$${(n / 1_000).toFixed(1)}K`;
  }
  return `${sign}$${n.toLocaleString("en-US", { maximumFractionDigits: abs < 100 ? 2 : 0 })}`;
}

export function pct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

/** signed percentage-point delta, e.g. +4.2 */
export function pp(delta: number, digits = 1): string {
  const v = delta * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function cents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

export function num(n: number, digits = 0): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function timeAgo(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function utcClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function utcDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return null;
  return Math.ceil((d - Date.now()) / 86400000);
}
