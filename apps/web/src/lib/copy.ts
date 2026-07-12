import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fetchTrades, type DataTrade } from "@sentry-app/polymarket";
import { useNotifications } from "./alerts";

/**
 * Copy engine — MANUAL SIGNAL mode (v1, non-custodial by design).
 * The engine watches tracked operators on the live tape; when a source trade
 * passes the strategy's filters it emits a copy signal for the user to
 * review and execute with their own wallet. No unattended signing.
 */

export interface CopyStrategy {
  id: string;
  wallet: string; // source operator (lowercase)
  alias: string;
  active: boolean;
  sizingMode: "FIXED" | "PROPORTIONAL";
  fixedUsd: number;
  proportionPct: number; // % of source notional
  maxPositionUsd: number;
  minSourceUsd: number; // ignore source trades below this
  side: "BUY" | "SELL" | "BOTH";
  createdAt: number;
  signalsGenerated: number;
}

export interface CopySignal {
  id: string;
  strategyId: string;
  ts: number; // source trade time (unix sec)
  wallet: string;
  alias: string;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
  price: number;
  sourceUsd: number;
  suggestedUsd: number;
  conditionId: string;
  marketTitle: string;
  marketSlug: string;
  eventSlug?: string;
  status: "PENDING" | "EXECUTED" | "DISMISSED";
}

interface CopyState {
  strategies: CopyStrategy[];
  signals: CopySignal[];
  _cursor: Record<string, number>; // strategyId -> last processed trade ts
  add: (s: Omit<CopyStrategy, "id" | "createdAt" | "signalsGenerated">) => void;
  update: (id: string, patch: Partial<CopyStrategy>) => void;
  remove: (id: string) => void;
  setSignalStatus: (id: string, status: CopySignal["status"]) => void;
  onTape: (trades: DataTrade[]) => void;
  /** direct per-operator poll — reliable even when the global tape scrolls past a wallet */
  pollTrackedOperators: () => Promise<void>;
}

export const useCopy = create<CopyState>()(
  persist(
    (set, get) => ({
      strategies: [],
      signals: [],
      _cursor: {},

      add: (s) =>
        set((st) => ({
          strategies: [
            {
              ...s,
              wallet: s.wallet.toLowerCase(),
              id: `CS-${String(st.strategies.length + 1).padStart(2, "0")}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
              createdAt: Date.now(),
              signalsGenerated: 0,
            },
            ...st.strategies,
          ],
          // start the cursor at "now" so pre-existing history isn't replayed
          _cursor: { ...st._cursor },
        })),

      update: (id, patch) =>
        set((st) => ({
          strategies: st.strategies.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        })),

      remove: (id) =>
        set((st) => ({
          strategies: st.strategies.filter((s) => s.id !== id),
          signals: st.signals.filter((sig) => sig.strategyId !== id),
        })),

      setSignalStatus: (id, status) =>
        set((st) => ({
          signals: st.signals.map((s) => (s.id === id ? { ...s, status } : s)),
        })),

      onTape: (trades) => {
        const { strategies, signals, _cursor } = get();
        const active = strategies.filter((s) => s.active);
        if (!active.length || !trades.length) return;
        const notify = useNotifications.getState().push;

        const byWallet = new Map<string, DataTrade[]>();
        for (const t of trades) {
          const w = t.proxyWallet.toLowerCase();
          const arr = byWallet.get(w);
          if (arr) arr.push(t);
          else byWallet.set(w, [t]);
        }

        const newSignals: CopySignal[] = [];
        const cursor = { ..._cursor };
        let generated: Record<string, number> = {};

        for (const strat of active) {
          const source = byWallet.get(strat.wallet) ?? [];
          if (!source.length) continue;
          const since = cursor[strat.id] ?? Math.floor(Date.now() / 1000) - 60; // first pass: last minute only
          let maxTs = since;
          for (const t of source) {
            if (t.timestamp <= since) continue;
            maxTs = Math.max(maxTs, t.timestamp);
            const usd = t.size * t.price;
            if (usd < strat.minSourceUsd) continue;
            if (strat.side !== "BOTH" && t.side !== strat.side) continue;
            const suggested = Math.min(
              strat.sizingMode === "FIXED" ? strat.fixedUsd : (usd * strat.proportionPct) / 100,
              strat.maxPositionUsd,
            );
            const sig: CopySignal = {
              id: `cp-${t.transactionHash.slice(2, 10)}-${t.asset.slice(0, 6)}`,
              strategyId: strat.id,
              ts: t.timestamp,
              wallet: strat.wallet,
              alias: strat.alias,
              side: t.side,
              outcome: t.outcome,
              outcomeIndex: t.outcomeIndex,
              price: t.price,
              sourceUsd: usd,
              suggestedUsd: suggested,
              conditionId: t.conditionId,
              marketTitle: t.title,
              marketSlug: t.slug,
              eventSlug: t.eventSlug,
              status: "PENDING",
            };
            if (!signals.some((s) => s.id === sig.id)) {
              newSignals.push(sig);
              generated[strat.id] = (generated[strat.id] ?? 0) + 1;
              notify({
                kind: "COPY",
                title: "COPY SIGNAL",
                body: `${strat.alias} ${t.side} ${t.outcome} — ${sig.marketTitle}`,
                href: "/copy",
              });
            }
          }
          cursor[strat.id] = maxTs;
        }

        if (newSignals.length || Object.keys(generated).length) {
          set((st) => ({
            signals: [...newSignals, ...st.signals].slice(0, 150),
            _cursor: cursor,
            strategies: st.strategies.map((s) =>
              generated[s.id] ? { ...s, signalsGenerated: s.signalsGenerated + generated[s.id] } : s,
            ),
          }));
        } else {
          set({ _cursor: cursor });
        }
      },

      pollTrackedOperators: async () => {
        const active = get().strategies.filter((s) => s.active);
        if (!active.length) return;
        const wallets = [...new Set(active.map((s) => s.wallet))];
        try {
          const batches = await Promise.all(
            wallets.map((w) => fetchTrades({ user: w, limit: 20, takerOnly: false }).catch(() => [])),
          );
          const merged = batches.flat();
          if (merged.length) get().onTape(merged);
        } catch {
          /* transient network fault — next tick retries */
        }
      },
    }),
    {
      name: "sentry.copy",
      partialize: (s) => ({
        strategies: s.strategies,
        signals: s.signals.slice(0, 60),
        _cursor: s._cursor,
      }),
    },
  ),
);
