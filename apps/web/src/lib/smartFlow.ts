import { create } from "zustand";
import { fetchLeaderboard, fetchPositions, fetchTrades } from "@sentry-app/polymarket";

/**
 * ELITE OPERATOR FLOW — the desk shadows the highest-conviction wallets.
 *
 * Every 5 minutes the 7d/30d/all-time P&L leaderboards are re-scored: for
 * each wallet we pull positions and compute a REALIZED win rate (closed
 * positions with realizedPnl > 0 vs < 0, dust excluded). Wallets at ≥90%
 * win over ≥10 settled positions form the elite tier; when the live
 * leaderboard holds none (verified 2026-07-12: best real rates were 87/83%),
 * the highest win-rate wallets above a 70% floor are tracked instead —
 * always labeled with their TRUE measured rate, never a pretended 90.
 * A fresh BUY from a tracked wallet becomes an alpha boost in the sweep.
 */

export interface EliteOperator {
  wallet: string;
  name: string;
  winRate: number;
  settled: number;
  pnl: number;
}

export interface SmartBuy {
  wallet: string;
  name: string;
  winRate: number;
  conditionId: string;
  outcome: string;
  price: number;
  ts: number; // seconds
}

interface SmartFlowState {
  elite: EliteOperator[];
  /** key: `${conditionId}:${outcome.toLowerCase()}` → freshest elite BUY */
  buys: Record<string, SmartBuy>;
  ok: boolean;
  start: () => void;
}

const WIN_RATE_ELITE = 0.9;
const WIN_RATE_FLOOR = 0.7;
const MIN_SETTLED = 10;
const ELITE_REFRESH_MS = 5 * 60_000;
const BUY_POLL_MS = 25_000;
const BUY_FRESH_SEC = 45 * 60;
const MAX_TRACKED = 12;

let eliteTimer: ReturnType<typeof setInterval> | null = null;
let buyTimer: ReturnType<typeof setInterval> | null = null;
let eliteBusy = false;
let buyBusy = false;

export const useSmartFlow = create<SmartFlowState>((set, get) => ({
  elite: [],
  buys: {},
  ok: false,

  start: () => {
    if (eliteTimer) return;

    const refreshElite = async () => {
      if (eliteBusy) return;
      eliteBusy = true;
      try {
        const boards = await Promise.all(
          (["7d", "30d", "all"] as const).map((w) => fetchLeaderboard(w, 30).catch(() => [])),
        );
        const seen = new Set<string>();
        const board = boards.flat().filter((w) => {
          if (seen.has(w.proxyWallet)) return false;
          seen.add(w.proxyWallet);
          return true;
        });
        const scored = await Promise.all(
          board.map(async (w) => {
            try {
              const pos = await fetchPositions({ user: w.proxyWallet, limit: 200, sortBy: "CASHPNL" });
              let wins = 0;
              let losses = 0;
              for (const p of pos) {
                if (p.realizedPnl > 0.5) wins++;
                else if (p.realizedPnl < -0.5) losses++;
              }
              const settled = wins + losses;
              if (settled < MIN_SETTLED) return null;
              const winRate = wins / settled;
              if (winRate < WIN_RATE_FLOOR) return null; // hard floor — never shadow coin-flippers
              return {
                wallet: w.proxyWallet,
                name: w.userName || `${w.proxyWallet.slice(0, 6)}…${w.proxyWallet.slice(-4)}`,
                winRate,
                settled,
                pnl: w.pnl,
              } satisfies EliteOperator;
            } catch {
              return null;
            }
          }),
        );
        const ranked = scored
          .filter((x): x is EliteOperator => x !== null)
          .sort((a, b) => b.winRate - a.winRate || b.pnl - a.pnl);
        // ≥90% wallets take every slot they can fill; the remainder goes to
        // the best measured rates above the 70% floor
        const hi = ranked.filter((x) => x.winRate >= WIN_RATE_ELITE);
        const elite = [...hi, ...ranked.filter((x) => x.winRate < WIN_RATE_ELITE)].slice(0, MAX_TRACKED);
        set({ elite, ok: true });
      } catch {
        /* leaderboard unavailable — keep last set */
      } finally {
        eliteBusy = false;
      }
    };

    const pollBuys = async () => {
      if (buyBusy) return;
      const elite = get().elite;
      if (!elite.length) return;
      buyBusy = true;
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const batches = await Promise.all(
          elite.map(async (op) => {
            try {
              const trades = await fetchTrades({ user: op.wallet, limit: 15, takerOnly: false });
              return trades
                .filter((t) => t.side === "BUY" && nowSec - t.timestamp < BUY_FRESH_SEC)
                .map((t): SmartBuy => ({
                  wallet: op.wallet,
                  name: op.name,
                  winRate: op.winRate,
                  conditionId: t.conditionId,
                  outcome: t.outcome,
                  price: t.price,
                  ts: t.timestamp,
                }));
            } catch {
              return [] as SmartBuy[];
            }
          }),
        );
        const buys: Record<string, SmartBuy> = {};
        for (const b of batches.flat()) {
          const key = `${b.conditionId}:${b.outcome.toLowerCase()}`;
          const prev = buys[key];
          // keep the strongest signal per market outcome: highest win rate,
          // then freshest print
          if (!prev || b.winRate > prev.winRate || (b.winRate === prev.winRate && b.ts > prev.ts)) {
            buys[key] = b;
          }
        }
        set({ buys });
      } finally {
        buyBusy = false;
      }
    };

    void refreshElite().then(() => void pollBuys());
    eliteTimer = setInterval(() => void refreshElite(), ELITE_REFRESH_MS);
    buyTimer = setInterval(() => void pollBuys(), BUY_POLL_MS);
    void buyTimer;
  },
}));
