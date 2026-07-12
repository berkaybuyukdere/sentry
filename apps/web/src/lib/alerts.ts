import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Market, Signal } from "@sentry-app/polymarket";

// ---------------------------------------------------------------------------
// Notifications — the terminal's internal event log
// ---------------------------------------------------------------------------

export interface Notification {
  id: string;
  ts: number;
  kind: "SIGNAL" | "RULE" | "COPY" | "ORDER" | "SYSTEM";
  title: string;
  body: string;
  href?: string;
  seen: boolean;
}

interface NotificationState {
  items: Notification[];
  push: (n: Omit<Notification, "id" | "ts" | "seen">) => void;
  markAllSeen: () => void;
  clear: () => void;
}

let nid = 0;

export const useNotifications = create<NotificationState>((set) => ({
  items: [],
  push: (n) =>
    set((s) => ({
      items: [
        { ...n, id: `n${Date.now()}-${nid++}`, ts: Date.now(), seen: false },
        ...s.items,
      ].slice(0, 200),
    })),
  markAllSeen: () => set((s) => ({ items: s.items.map((i) => ({ ...i, seen: true })) })),
  clear: () => set({ items: [] }),
}));

// ---------------------------------------------------------------------------
// Monitoring rules — user-authored alert conditions
// ---------------------------------------------------------------------------

export type RuleMetric =
  | "PROBABILITY"
  | "DELTA_1H"
  | "DELTA_24H"
  | "VOLUME_24H"
  | "WHALE_TRADE_USD"
  | "SMART_CLUSTER";

export type RuleOp = "ABOVE" | "BELOW";

export interface Rule {
  id: string;
  name: string;
  metric: RuleMetric;
  op: RuleOp;
  value: number;
  /** empty = global scope (any market) */
  marketSlug: string | null;
  marketTitle: string | null;
  active: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  fireCount: number;
}

interface RuleState {
  rules: Rule[];
  add: (r: Omit<Rule, "id" | "createdAt" | "lastFiredAt" | "fireCount">) => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;
  markFired: (id: string, ts: number) => void;
}

export const useRules = create<RuleState>()(
  persist(
    (set) => ({
      rules: [],
      add: (r) =>
        set((s) => ({
          rules: [
            {
              ...r,
              id: `R-${String(s.rules.length + 1).padStart(2, "0")}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
              createdAt: Date.now(),
              lastFiredAt: null,
              fireCount: 0,
            },
            ...s.rules,
          ],
        })),
      toggle: (id) =>
        set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, active: !r.active } : r)) })),
      remove: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
      markFired: (id, ts) =>
        set((s) => ({
          rules: s.rules.map((r) =>
            r.id === id ? { ...r, lastFiredAt: ts, fireCount: r.fireCount + 1 } : r,
          ),
        })),
    }),
    { name: "sentry.rules" },
  ),
);

const REARM_MS = 30 * 60_000; // a fired rule stays quiet for 30m

/** Evaluate all active rules against current markets + fresh signals. */
export function evaluateRules(
  markets: Market[],
  freshSignals: Signal[],
  now: number,
): { rule: Rule; message: string }[] {
  const { rules, markFired } = useRules.getState();
  const fired: { rule: Rule; message: string }[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.lastFiredAt && now - rule.lastFiredAt < REARM_MS) continue;
    const scope = rule.marketSlug
      ? markets.filter((m) => m.slug === rule.marketSlug)
      : markets;

    let message: string | null = null;
    switch (rule.metric) {
      case "PROBABILITY": {
        const hit = scope.find((m) =>
          rule.op === "ABOVE" ? m.probability * 100 >= rule.value : m.probability * 100 <= rule.value,
        );
        if (hit)
          message = `${hit.question} — probability ${(hit.probability * 100).toFixed(1)}% ${rule.op === "ABOVE" ? "≥" : "≤"} ${rule.value}%`;
        break;
      }
      case "DELTA_1H": {
        const hit = scope.find((m) => Math.abs(m.delta1h * 100) >= rule.value);
        if (hit) message = `${hit.question} — 1h move ${(hit.delta1h * 100).toFixed(1)}pp`;
        break;
      }
      case "DELTA_24H": {
        const hit = scope.find((m) => Math.abs(m.delta24h * 100) >= rule.value);
        if (hit) message = `${hit.question} — 24h move ${(hit.delta24h * 100).toFixed(1)}pp`;
        break;
      }
      case "VOLUME_24H": {
        const hit = scope.find((m) =>
          rule.op === "ABOVE" ? m.volume24h >= rule.value : m.volume24h <= rule.value,
        );
        if (hit) message = `${hit.question} — 24h volume $${Math.round(hit.volume24h).toLocaleString()}`;
        break;
      }
      case "WHALE_TRADE_USD": {
        const sig = freshSignals.find(
          (s) =>
            s.type === "WHALE_ENTRY" &&
            s.usd >= rule.value &&
            (!rule.marketSlug || s.marketSlug === rule.marketSlug),
        );
        if (sig) message = `${sig.marketTitle} — single fill $${Math.round(sig.usd).toLocaleString()}`;
        break;
      }
      case "SMART_CLUSTER": {
        const sig = freshSignals.find(
          (s) =>
            (s.type === "SMART_WALLET_CLUSTER" || s.type === "CLUSTER_ENTRY") &&
            s.wallets.length >= rule.value &&
            (!rule.marketSlug || s.marketSlug === rule.marketSlug),
        );
        if (sig) message = `${sig.marketTitle} — ${sig.wallets.length} wallets, $${Math.round(sig.usd).toLocaleString()} combined`;
        break;
      }
    }

    if (message) {
      markFired(rule.id, now);
      fired.push({ rule, message });
    }
  }
  return fired;
}
