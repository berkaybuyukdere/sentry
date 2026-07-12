import { create } from "zustand";
import { useEffect } from "react";
import {
  scanTape,
  scanMarkets,
  smartWalletSet,
  severityRank,
  type Signal,
} from "@sentry-app/polymarket";
import { useTape } from "./tape";
import { useMarkets, useLeaderboard } from "./queries";
import { useNotifications } from "./alerts";
import { useCopy } from "./copy";

interface SignalState {
  signals: Signal[]; // newest first, deduped by id
  firstSeen: Record<string, number>;
  ingest: (incoming: Signal[]) => Signal[]; // returns genuinely-new signals
}

const MAX_SIGNALS = 400;

export const useSignals = create<SignalState>((set, get) => ({
  signals: [],
  firstSeen: {},
  ingest: (incoming) => {
    const { signals, firstSeen } = get();
    const known = new Set(signals.map((s) => s.id));
    const fresh = incoming.filter((s) => !known.has(s.id));
    if (!fresh.length) return [];
    const now = Date.now();
    const seen = { ...firstSeen };
    for (const s of fresh) seen[s.id] = now;
    const merged = [...fresh, ...signals]
      .sort((a, b) => b.ts - a.ts || severityRank(b.severity) - severityRank(a.severity))
      .slice(0, MAX_SIGNALS);
    set({ signals: merged, firstSeen: seen });
    return fresh;
  },
}));

/**
 * The signal engine — mounted once inside the workspace shell.
 * Fuses the live tape, the smart-money cohort and market snapshots into
 * deduplicated intelligence signals, and routes them to notifications
 * and the copy engine.
 */
export function useSignalEngine() {
  const start = useTape((s) => s.start);
  const trades = useTape((s) => s.trades);
  const { data: leaderboard } = useLeaderboard("30d", 50);
  const { data: markets } = useMarkets({ limit: 300, order: "volume24hr" }, 45_000);
  const ingest = useSignals((s) => s.ingest);
  const notify = useNotifications((s) => s.push);
  const onTapeForCopy = useCopy((s) => s.onTape);

  const pollTrackedOperators = useCopy((s) => s.pollTrackedOperators);

  useEffect(() => {
    start();
  }, [start]);

  // direct per-operator poll for the copy engine — reliable regardless of
  // how fast the global tape scrolls past an individual wallet
  useEffect(() => {
    const t = setInterval(() => void pollTrackedOperators(), 12_000);
    void pollTrackedOperators();
    return () => clearInterval(t);
  }, [pollTrackedOperators]);

  // tape-driven signals
  useEffect(() => {
    if (!trades.length) return;
    const smart = smartWalletSet(leaderboard ?? []);
    const fresh = ingest(scanTape(trades, smart));
    for (const s of fresh) {
      if (severityRank(s.severity) >= 2) {
        notify({
          kind: "SIGNAL",
          title: s.type.replaceAll("_", " "),
          body: `${s.marketTitle ?? ""} — ${s.title}`,
          href: s.marketSlug ? `/market/${s.marketSlug}` : "/signals",
        });
      }
    }
    onTapeForCopy(trades);
  }, [trades, leaderboard, ingest, notify, onTapeForCopy]);

  // snapshot-driven signals (volume anomalies, probability acceleration)
  useEffect(() => {
    if (!markets?.length) return;
    ingest(scanMarkets(markets));
  }, [markets, ingest]);
}
