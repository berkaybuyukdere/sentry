import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * SENTRY revenue architecture — subscription + execution fees + operator economy.
 *
 * Model: "We earn when we execute." Fees apply only to successfully executed
 * notional; failed/unfilled orders accrue nothing. All taker-side execution
 * rates sit inside Polymarket's Builder Program ceiling (1.00% taker).
 *
 * Billing rails status: tier switching + fee accrual run live against a local
 * ledger for design validation; on-chain fee collection activates with Builder
 * Program registration, and card billing with the app backend. No hidden fees:
 * every rate is printed where it applies.
 */

export type TierId = "ACCESS" | "OPERATOR" | "PRO" | "BLACK";
export type ExecOrigin = "MANUAL" | "SIGNAL" | "COPY";

export interface Tier {
  id: TierId;
  name: string;
  monthlyUsd: number;
  /** execution rates in bps by origin */
  rates: Record<ExecOrigin, number>;
  entitlements: {
    watchlists: number | null; // null = unlimited
    copyStrategies: number | null;
    aiDesk: boolean;
    features: string[];
  };
}

export const TIERS: Tier[] = [
  {
    id: "ACCESS",
    name: "ACCESS",
    monthlyUsd: 0,
    rates: { MANUAL: 85, SIGNAL: 95, COPY: 95 },
    entitlements: {
      watchlists: 3,
      copyStrategies: 1,
      aiDesk: false,
      features: [
        "Market Terminal",
        "Basic Signals",
        "Top Operators",
        "Wallet Profiles",
        "3 Watchlists",
        "Manual Trading",
        "1 Active Copy Strategy",
      ],
    },
  },
  {
    id: "OPERATOR",
    name: "OPERATOR",
    monthlyUsd: 29,
    rates: { MANUAL: 60, SIGNAL: 70, COPY: 75 },
    entitlements: {
      watchlists: null,
      copyStrategies: 5,
      aiDesk: false,
      features: [
        "Full Market Scanner",
        "Advanced Signals",
        "Wallet Intelligence",
        "Unlimited Watchlists",
        "5 Active Copy Strategies",
        "Smart Money Tracking",
        "Advanced Alerts",
        "Operator Rankings",
      ],
    },
  },
  {
    id: "PRO",
    name: "PRO",
    monthlyUsd: 99,
    rates: { MANUAL: 30, SIGNAL: 40, COPY: 50 },
    entitlements: {
      watchlists: null,
      copyStrategies: null,
      aiDesk: true,
      features: [
        "Unlimited Copy Strategies",
        "Signal Engine Pro",
        "Smart Wallet Clusters",
        "Capital Flow Intelligence",
        "Network Intelligence Graph",
        "Portfolio Correlation Analysis",
        "AI Operations Desk",
        "Advanced Execution Rules",
        "Priority Data",
        "Strategy Analytics",
      ],
    },
  },
  {
    id: "BLACK",
    name: "BLACK",
    monthlyUsd: 299,
    rates: { MANUAL: 15, SIGNAL: 20, COPY: 25 },
    entitlements: {
      watchlists: null,
      copyStrategies: null,
      aiDesk: true,
      features: [
        "Maximum Execution Priority",
        "Unlimited Automation",
        "Private Wallet Groups",
        "Custom Signal Models",
        "Multi-Wallet Intelligence",
        "Institutional Risk Terminal",
        "API Access",
        "Data Export",
        "Private Strategy Workspace",
        "Early Feature Access",
      ],
    },
  },
];

export const tierById = (id: TierId): Tier => TIERS.find((t) => t.id === id)!;

// ---------------------------------------------------------------------------
// Operator reward tiers — the copy-economy flywheel
// ---------------------------------------------------------------------------

export type OperatorRewardTier = "STANDARD" | "VERIFIED" | "TIER-1" | "ELITE";

/** share of copied notional routed to the source operator, in bps */
export const OPERATOR_REWARD_BPS: Record<OperatorRewardTier, number> = {
  STANDARD: 5,
  VERIFIED: 8,
  "TIER-1": 12,
  ELITE: 15,
};

/** classify a source operator by leaderboard position (50-wallet cohort). */
export function operatorRewardTier(rank: number | null): OperatorRewardTier {
  if (rank === null) return "STANDARD";
  if (rank <= 2) return "ELITE";
  if (rank <= 5) return "TIER-1";
  if (rank <= 25) return "VERIFIED";
  return "STANDARD";
}

// ---------------------------------------------------------------------------
// Fee engine + revenue ledger
// ---------------------------------------------------------------------------

export interface FeeQuote {
  origin: ExecOrigin;
  rateBps: number;
  feeUsd: number;
  operatorRewardBps: number;
  operatorRewardUsd: number;
  platformUsd: number;
}

export interface LedgerEntry {
  id: string;
  ts: number;
  origin: ExecOrigin;
  tier: TierId;
  market: string;
  notionalUsd: number;
  rateBps: number;
  feeUsd: number;
  operatorWallet: string | null;
  operatorRewardUsd: number;
  platformUsd: number;
}

interface BillingState {
  tier: TierId;
  ledger: LedgerEntry[];
  setTier: (t: TierId) => void;
  quote: (origin: ExecOrigin, notionalUsd: number, operatorRank?: number | null) => FeeQuote;
  accrue: (
    q: FeeQuote,
    meta: { market: string; notionalUsd: number; operatorWallet?: string | null },
  ) => void;
}

let seq = 0;

export const useBilling = create<BillingState>()(
  persist(
    (set, get) => ({
      tier: "ACCESS",
      ledger: [],

      setTier: (tier) => set({ tier }),

      quote: (origin, notionalUsd, operatorRank = null) => {
        const tier = tierById(get().tier);
        const rateBps = tier.rates[origin];
        const feeUsd = (notionalUsd * rateBps) / 10_000;
        const operatorRewardBps =
          origin === "COPY" ? OPERATOR_REWARD_BPS[operatorRewardTier(operatorRank)] : 0;
        const operatorRewardUsd = (notionalUsd * operatorRewardBps) / 10_000;
        return {
          origin,
          rateBps,
          feeUsd,
          operatorRewardBps,
          operatorRewardUsd: Math.min(operatorRewardUsd, feeUsd),
          platformUsd: Math.max(feeUsd - operatorRewardUsd, 0),
        };
      },

      accrue: (q, meta) =>
        set((s) => ({
          ledger: [
            {
              id: `F-${Date.now().toString(36)}-${seq++}`,
              ts: Date.now(),
              origin: q.origin,
              tier: s.tier,
              market: meta.market,
              notionalUsd: meta.notionalUsd,
              rateBps: q.rateBps,
              feeUsd: q.feeUsd,
              operatorWallet: meta.operatorWallet ?? null,
              operatorRewardUsd: q.operatorRewardUsd,
              platformUsd: q.platformUsd,
            },
            ...s.ledger,
          ].slice(0, 500),
        })),
    }),
    { name: "sentry.billing" },
  ),
);

export const bpsPct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Entitlement checks (soft gates — UI blocks + upgrade prompt). */
export function canCreateWatchlist(currentCount: number): boolean {
  const t = tierById(useBilling.getState().tier);
  return t.entitlements.watchlists === null || currentCount < t.entitlements.watchlists;
}

export function canActivateCopyStrategy(activeCount: number): boolean {
  const t = tierById(useBilling.getState().tier);
  return t.entitlements.copyStrategies === null || activeCount < t.entitlements.copyStrategies;
}

export function aiDeskEnabled(): boolean {
  return tierById(useBilling.getState().tier).entitlements.aiDesk;
}
