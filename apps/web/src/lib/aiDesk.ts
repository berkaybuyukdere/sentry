import { useEffect, useRef } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import Anthropic from "@anthropic-ai/sdk";
import {
  fetchOrderBook,
  bookStats,
  estimateFill,
  estimateSell,
  severityRank,
  domainKeyFromTitle,
  type Market,
  type Signal,
  type DataTrade,
} from "@sentry-app/polymarket";
import { useDeskUniverse } from "./queries";
import { useSignals } from "./signals";
import { useTape } from "./tape";
import { useLiveTokens, usePrices } from "./prices";
import { useNotifications } from "./alerts";
import { useBilling } from "./billing";
import { useTicket } from "../components/market/ticket";
import { useOrderLog } from "./trading/orderLog";
import { useLiveRef, cryptoAlignment, type RefRow } from "./liveRef";
import { useSmartFlow, type SmartBuy } from "./smartFlow";
import { USDC, PUSD, ERC20_ABI } from "./trading/constants";
import { cachedDepositWallet } from "./trading/v2client";

/**
 * AI OPERATIONS DESK — statistical engine v2.
 *
 * Pipeline each cycle, over a ~1,500-market universe:
 *   1. FILTER      — tempo horizon, liquidity/volume/spread floors, price band
 *   2. FACTORS     — cross-sectional z-scores (momentum, acceleration, turnover,
 *                    volume, spread quality) + live signal score + tape order-flow
 *                    imbalance, winsorized at ±3σ
 *   3. ALPHA       — risk-profile-weighted composite
 *   4. EV MODEL    — drift–diffusion barrier model: P(hit TP before SL) from
 *                    estimated hourly volatility + alpha-scaled drift, expected
 *                    hold time, and net EV after round-trip fees + spread cost.
 *                    Only positive-EV-after-costs trades are eligible.
 *   5. SIZING      — fractional-Kelly on EV per unit risk, clamped to the
 *                    operator's min/max and available cash
 *   6. PORTFOLIO   — rank by EV per hour (fast money first), diversify across
 *                    domains, one position per event, open up to N per cycle
 *
 * Two execution modes on this one engine: PAPER (autonomous simulation against
 * the real order book, tier fees deducted) and LIVE (wallet signs every order).
 */

export type RiskProfile = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
export type DeskMode = "ADVISE" | "ARM";
export type ExecutionMode = "PAPER" | "LIVE";
export type Tempo = "SCALP" | "INTRADAY" | "SWING";

export interface DeskConfig {
  executionMode: ExecutionMode;
  tempo: Tempo;
  startingCapitalUsd: number;
  budgetUsd: number;
  minTradeUsd: number;
  maxTradeUsd: number;
  targetProfitUsd: number;
  maxLossUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMin: number;
  risk: RiskProfile;
  minConfidence: number; // 0..10 alpha gate (EV>0 is a separate hard gate)
  domains: string[];
  maxPositions: number;
  mode: DeskMode;
  claudeEnabled: boolean;
  anthropicKey: string;
  anthropicModel: string;
  /** FULL AUTO: the desk derives sizing, risk and exits from the bankroll —
   *  the operator supplies only capital + target. */
  freeWill: boolean;
}

export interface DeskDecision {
  id: string;
  ts: number;
  slug: string;
  question: string;
  conditionId: string;
  eventSlug: string | null;
  tokenId: string;
  outcomeIndex: number;
  outcome: string;
  side: "BUY";
  price: number;
  sizeUsd: number; // Kelly-derived
  alpha: number; // composite z
  score: number; // 0..10 display mapping of alpha
  confidence: number; // 0..10
  pWin: number; // P(TP before SL)
  evCents: number; // net EV per share, cents, after fees+spread
  evPerHourUsd: number; // position EV / expected hold
  expHoldMin: number;
  tpFrac: number; // take-profit distance as fraction of entry (cost-clearing)
  slFrac: number; // stop-loss distance as fraction of entry
  eligible: boolean; // EV>0 AND backed by a real signal (momentum/signal/live spot)
  reasons: string[];
  aiVerdict: "GO" | "VETO" | null;
  aiNote: string | null;
  status: "PROPOSED" | "STAGED" | "FILLED" | "EXECUTED" | "SKIPPED" | "VETOED";
}

export interface PaperPosition {
  id: string;
  decisionId: string;
  slug: string;
  question: string;
  tokenId: string;
  outcome: string;
  entryPrice: number;
  shares: number;
  costUsd: number;
  feeUsd: number;
  ts: number;
  tpPrice: number;
  slPrice: number;
  deadline: number;
}

export interface ClosedTrade {
  id: string;
  slug: string;
  question: string;
  outcome: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  costUsd: number;
  proceedsUsd: number;
  feesUsd: number;
  pnl: number;
  openedTs: number;
  closedTs: number;
  reason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT" | "MANUAL" | "SESSION_HALT";
}

export interface PaperSession {
  active: boolean;
  startedAt: number;
  startingCapital: number;
  cash: number;
  feesPaid: number;
  positions: PaperPosition[];
  closed: ClosedTrade[];
}

export interface ScanStats {
  universe: number;
  filtered: number;
  qualifiers: number;
  evPositive: number;
  plannedThisCycle: number;
  avgHoldMin: number;
  smart: number; // candidates carrying fresh elite-operator flow
  scannedAt: number;
}

const EMPTY_PAPER: PaperSession = {
  active: false,
  startedAt: 0,
  startingCapital: 0,
  cash: 0,
  feesPaid: 0,
  positions: [],
  closed: [],
};

const EMPTY_SCAN: ScanStats = {
  universe: 0,
  filtered: 0,
  qualifiers: 0,
  evPositive: 0,
  plannedThisCycle: 0,
  avgHoldMin: 0,
  smart: 0,
  scannedAt: 0,
};

interface DeskState {
  config: DeskConfig;
  engaged: boolean;
  haltReason: string | null;
  liveBaseline: number | null; // wallet USDC.e at LIVE engage — target/loss anchor
  decisions: DeskDecision[];
  aiStatus: string | null;
  paper: PaperSession;
  scan: ScanStats;
  liveExecuted: { decisionId: string; ts: number; slug: string; question: string; tokenId: string; outcome: string; entryPrice: number; usd: number; shares: number }[];
  setConfig: (patch: Partial<DeskConfig>) => void;
  setTempo: (t: Tempo) => void;
  setEngaged: (v: boolean) => void;
  setHalt: (reason: string) => void;
  setLiveBaseline: (v: number | null) => void;
  replaceProposals: (d: DeskDecision[], scan: ScanStats) => void;
  setDecisionStatus: (id: string, status: DeskDecision["status"]) => void;
  applyAiVerdicts: (verdicts: { id: string; go: boolean; note: string }[]) => void;
  recordLiveExecution: (r: DeskState["liveExecuted"][number]) => void;
  startPaperSession: () => void;
  stopPaperSession: () => void;
  paperOpen: (p: PaperPosition) => void;
  paperClose: (positionId: string, exitPrice: number, proceeds: number, exitFee: number, reason: ClosedTrade["reason"]) => void;
  setAiStatus: (s: string | null) => void;
  resetDecisions: () => void;
}

/** Tempo presets — the speed dial. SCALP = fast money, short holds, quick recycling. */
export const TEMPO_PARAMS: Record<Tempo, {
  maxDays: number;
  tpPct: number;
  slPct: number;
  maxHoldMin: number;
  scanMs: number;
  entriesPerCycle: number;
  defaultMaxPositions: number;
  driftPerZ: number; // fraction of hourly σ per unit alpha
  maxSpread: number; // spread ceiling — scalps need tight books to clear costs
}> = {
  SCALP: { maxDays: 3, tpPct: 4, slPct: 5, maxHoldMin: 15, scanMs: 5_000, entriesPerCycle: 10, defaultMaxPositions: 30, driftPerZ: 0.4, maxSpread: 0.02 },
  INTRADAY: { maxDays: 10, tpPct: 12, slPct: 8, maxHoldMin: 240, scanMs: 20_000, entriesPerCycle: 3, defaultMaxPositions: 10, driftPerZ: 0.32, maxSpread: 0.035 },
  SWING: { maxDays: 45, tpPct: 20, slPct: 12, maxHoldMin: 1440, scanMs: 45_000, entriesPerCycle: 2, defaultMaxPositions: 6, driftPerZ: 0.28, maxSpread: 0.05 },
};

const RISK_PARAMS: Record<RiskProfile, {
  minLiq: number;
  minVol: number;
  maxSpread: number;
  priceBand: [number, number];
  kellyFraction: number;
  weights: { momentum: number; accel: number; signal: number; flow: number; turnover: number; volume: number; spreadQ: number };
}> = {
  CONSERVATIVE: {
    minLiq: 20_000,
    minVol: 20_000,
    maxSpread: 0.012,
    priceBand: [0.15, 0.85],
    kellyFraction: 0.15,
    weights: { momentum: 0.2, accel: 0.1, signal: 0.15, flow: 0.15, turnover: 0.1, volume: 0.1, spreadQ: 0.2 },
  },
  BALANCED: {
    minLiq: 6_000,
    minVol: 8_000,
    maxSpread: 0.025,
    priceBand: [0.1, 0.9],
    kellyFraction: 0.25,
    weights: { momentum: 0.25, accel: 0.15, signal: 0.15, flow: 0.15, turnover: 0.12, volume: 0.08, spreadQ: 0.1 },
  },
  AGGRESSIVE: {
    minLiq: 600,
    minVol: 800,
    maxSpread: 0.045,
    priceBand: [0.06, 0.94],
    kellyFraction: 0.4,
    weights: { momentum: 0.3, accel: 0.2, signal: 0.15, flow: 0.15, turnover: 0.12, volume: 0.05, spreadQ: 0.03 },
  },
};

export const DEFAULT_CONFIG: DeskConfig = {
  executionMode: "PAPER",
  tempo: "SCALP",
  startingCapitalUsd: 500,
  budgetUsd: 500,
  minTradeUsd: 1,
  maxTradeUsd: 3,
  targetProfitUsd: 50,
  maxLossUsd: 100,
  takeProfitPct: TEMPO_PARAMS.SCALP.tpPct,
  stopLossPct: TEMPO_PARAMS.SCALP.slPct,
  maxHoldMin: TEMPO_PARAMS.SCALP.maxHoldMin,
  risk: "BALANCED",
  // EV>0 (after real costs) is the hard quality gate; confidence is a soft
  // floor kept low so the desk trades actively, per the fast-money mandate.
  minConfidence: 5.5,
  domains: [],
  maxPositions: TEMPO_PARAMS.SCALP.defaultMaxPositions,
  mode: "ADVISE",
  claudeEnabled: false,
  anthropicKey: "",
  anthropicModel: "claude-opus-4-8",
  freeWill: true,
};

let pidSeq = 0;

export const useAiDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      engaged: false,
      haltReason: null,
      liveBaseline: null,
      decisions: [],
      aiStatus: null,
      paper: EMPTY_PAPER,
      scan: EMPTY_SCAN,
      liveExecuted: [],

      setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      setTempo: (tempo) =>
        set((s) => ({
          config: {
            ...s.config,
            tempo,
            takeProfitPct: TEMPO_PARAMS[tempo].tpPct,
            stopLossPct: TEMPO_PARAMS[tempo].slPct,
            maxHoldMin: TEMPO_PARAMS[tempo].maxHoldMin,
            maxPositions: TEMPO_PARAMS[tempo].defaultMaxPositions,
          },
        })),
      setEngaged: (engaged) => set((s) => ({ engaged, haltReason: engaged ? null : s.haltReason })),
      setHalt: (haltReason) => set({ haltReason, engaged: false }),
      setLiveBaseline: (liveBaseline) => set({ liveBaseline }),

      /** Fresh proposals rebuild the feed each sweep. Only STAGED rows (a live
       *  order awaiting the user's signature) are preserved; FILLED/closed/vetoed
       *  markets are free to be re-proposed — this is what enables rapid re-entry
       *  churn into hot markets. */
      replaceProposals: (incoming, scan) =>
        set((s) => {
          const keep = s.decisions.filter((d) => d.status === "STAGED");
          const keepIds = new Set(keep.map((d) => d.id));
          const fresh = incoming.filter((d) => !keepIds.has(d.id));
          return {
            scan,
            decisions: [...fresh, ...keep].slice(0, 80),
          };
        }),

      setDecisionStatus: (id, status) =>
        set((s) => ({ decisions: s.decisions.map((d) => (d.id === id ? { ...d, status } : d)) })),

      applyAiVerdicts: (verdicts) =>
        set((s) => ({
          decisions: s.decisions.map((d) => {
            const v = verdicts.find((x) => x.id === d.id);
            if (!v) return d;
            return {
              ...d,
              aiVerdict: v.go ? "GO" : "VETO",
              aiNote: v.note,
              status: !v.go && d.status === "PROPOSED" ? "VETOED" : d.status,
            };
          }),
        })),

      recordLiveExecution: (r) =>
        set((s) => ({
          liveExecuted: [r, ...s.liveExecuted].slice(0, 100),
          decisions: s.decisions.map((d) => (d.id === r.decisionId ? { ...d, status: "EXECUTED" } : d)),
        })),

      startPaperSession: () =>
        set((s) => ({
          engaged: true,
          haltReason: null,
          decisions: [],
          scan: EMPTY_SCAN,
          paper: {
            active: true,
            startedAt: Date.now(),
            startingCapital: s.config.startingCapitalUsd,
            cash: s.config.startingCapitalUsd,
            feesPaid: 0,
            positions: [],
            closed: [],
          },
        })),

      stopPaperSession: () => set((s) => ({ engaged: false, paper: { ...s.paper, active: false } })),

      paperOpen: (p) =>
        set((s) => ({
          paper: {
            ...s.paper,
            cash: s.paper.cash - p.costUsd - p.feeUsd,
            feesPaid: s.paper.feesPaid + p.feeUsd,
            positions: [p, ...s.paper.positions],
          },
          decisions: s.decisions.map((d) => (d.id === p.decisionId ? { ...d, status: "FILLED" } : d)),
        })),

      paperClose: (positionId, exitPrice, proceeds, exitFee, reason) =>
        set((s) => {
          const pos = s.paper.positions.find((p) => p.id === positionId);
          if (!pos) return s;
          const trade: ClosedTrade = {
            id: pos.id,
            slug: pos.slug,
            question: pos.question,
            outcome: pos.outcome,
            entryPrice: pos.entryPrice,
            exitPrice,
            shares: pos.shares,
            costUsd: pos.costUsd,
            proceedsUsd: proceeds,
            feesUsd: pos.feeUsd + exitFee,
            pnl: proceeds - exitFee - pos.costUsd - pos.feeUsd,
            openedTs: pos.ts,
            closedTs: Math.floor(Date.now() / 1000),
            reason,
          };
          return {
            paper: {
              ...s.paper,
              cash: s.paper.cash + proceeds - exitFee,
              feesPaid: s.paper.feesPaid + exitFee,
              positions: s.paper.positions.filter((p) => p.id !== positionId),
              closed: [trade, ...s.paper.closed].slice(0, 300),
            },
          };
        }),

      setAiStatus: (aiStatus) => set({ aiStatus }),
      resetDecisions: () => set({ decisions: [], scan: EMPTY_SCAN, haltReason: null }),
    }),
    {
      name: "sentry.aiDesk",
      partialize: (s) => ({ config: s.config, paper: s.paper, liveExecuted: s.liveExecuted.slice(0, 40) }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DeskState>;
        const paper = { ...EMPTY_PAPER, ...(p.paper ?? {}) };
        return {
          ...current,
          ...p,
          config: { ...DEFAULT_CONFIG, ...(p.config ?? {}) },
          paper,
          scan: EMPTY_SCAN,
          liveExecuted: p.liveExecuted ?? [],
          // an active paper session resumes fully autonomous after reload
          engaged: paper.active,
        };
      },
    },
  ),
);

/** FREE-WILL derivation: everything scales from live equity so the same desk
 *  is sane at $500 and at $50,000. Clips 0.2–2% of equity, tempo exits,
 *  loss brake 10% of starting capital. The operator's target is respected. */
export function effectiveDeskConfig(cfg: DeskConfig, equity: number, startingCapital: number): DeskConfig {
  if (!cfg.freeWill) return cfg;
  const T = TEMPO_PARAMS[cfg.tempo];
  const eq = Math.max(equity, 10);
  const minTrade = Math.max(1, Math.round(eq * 0.002));
  return {
    ...cfg,
    minTradeUsd: minTrade,
    maxTradeUsd: Math.max(minTrade * 2, Math.round(Math.min(eq * 0.03, 2500))),
    maxPositions: T.defaultMaxPositions,
    takeProfitPct: T.tpPct,
    stopLossPct: T.slPct,
    maxHoldMin: T.maxHoldMin,
    maxLossUsd: Math.max(25, Math.round(startingCapital * 0.1)),
  };
}

/** Gradual-deployment ladder: start at 12% of bankroll in the market, earn
 *  headroom with realized profit (+5× realized as % of capital), never exceed
 *  50%. In drawdown the cap shrinks toward a 8% floor — losses slow the desk
 *  down instead of doubling it up. */
export function deployCapFrac(realizedPnl: number, capital: number): number {
  if (capital <= 0) return 0.12;
  const r = realizedPnl / capital;
  return Math.max(0.25, Math.min(0.7, 0.55 + r * 4));
}

export function paperEquity(paper: PaperSession, markOf: (tokenId: string, fallback: number) => number): number {
  return paper.cash + paper.positions.reduce((s, p) => s + markOf(p.tokenId, p.entryPrice) * p.shares, 0);
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function meanStd(xs: number[]): { mean: number; std: number } {
  if (!xs.length) return { mean: 0, std: 1 };
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const varr = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(xs.length - 1, 1);
  return { mean, std: Math.sqrt(varr) || 1 };
}

const winsor = (z: number) => Math.max(-3, Math.min(3, z));

/**
 * Drift–diffusion barrier model.
 * P(hit +b before −a) for Brownian motion with drift μ and volatility σ:
 *   θ = 2μ/σ²,  P = (1 − e^{−θa}) / (1 − e^{−θ(a+b)});  μ→0 limit: a/(a+b).
 * Expected hold ≈ a·b/σ² hours (driftless approximation, capped by maxHold).
 */
function barrierModel(a: number, b: number, muHr: number, sigHr: number) {
  const s2 = Math.max(sigHr * sigHr, 1e-6);
  let p: number;
  if (Math.abs(muHr) < 1e-9) {
    p = a / (a + b);
  } else {
    const th = (2 * muHr) / s2;
    const num = 1 - Math.exp(-th * a);
    const den = 1 - Math.exp(-th * (a + b));
    p = Math.abs(den) < 1e-12 ? a / (a + b) : num / den;
  }
  p = Math.max(0.02, Math.min(0.98, p));
  const holdHr = (a * b) / s2;
  return { pWin: p, holdHr };
}

// ---------------------------------------------------------------------------
// THE SWEEP — filter → z-score → alpha → EV → Kelly → portfolio plan
// ---------------------------------------------------------------------------

export interface SweepResult {
  decisions: DeskDecision[];
  scan: ScanStats;
}

export function sweepUniverse(
  markets: Market[],
  signals: Signal[],
  tape: DataTrade[],
  cfg: DeskConfig,
  feeRateBps: number,
  equityUsd: number,
  exclude: Set<string>,
  excludeEvents: Set<string>,
  openSlots: number,
  cryptoRows: Record<string, RefRow> = {},
  smartBuys: Record<string, SmartBuy> = {},
): SweepResult {
  const T = TEMPO_PARAMS[cfg.tempo];
  const R = RISK_PARAMS[cfg.risk];
  const nowSec = Math.floor(Date.now() / 1000);

  // --- signal index with 30-min half-life recency decay ---------------------
  const sigScore = new Map<string, { score: number; top: Signal }>();
  for (const s of signals) {
    if (!s.conditionId) continue;
    const age = Math.max(0, nowSec - s.ts);
    const decay = Math.pow(0.5, age / 1800);
    const raw = ((severityRank(s.severity) + 1) / 4) * (0.5 + s.confidence * 0.5) * decay;
    const cur = sigScore.get(s.conditionId);
    if (!cur || raw > cur.score) sigScore.set(s.conditionId, { score: raw, top: s });
  }

  // --- tape order-flow imbalance per market (last 30 min) -------------------
  const flow = new Map<string, number>(); // conditionId -> net notional / gross
  {
    const agg = new Map<string, { buy: number; sell: number }>();
    for (const t of tape) {
      if (nowSec - t.timestamp > 1800) continue;
      const usd = t.size * t.price;
      const e = agg.get(t.conditionId) ?? { buy: 0, sell: 0 };
      if (t.side === "BUY") e.buy += usd;
      else e.sell += usd;
      agg.set(t.conditionId, e);
    }
    for (const [cid, e] of agg) {
      const gross = e.buy + e.sell;
      if (gross > 200) flow.set(cid, (e.buy - e.sell) / gross);
    }
  }

  // --- stage 1: hard filters -------------------------------------------------
  type Row = {
    m: Market;
    outcomeIndex: number;
    price: number;
    dirSign: 1 | -1; // direction of the chosen outcome in Δ terms
    momentum: number;
    accel: number;
    turnover: number;
    logVol: number;
    spreadQ: number;
    sig: number;
    sigTop: Signal | null;
    flowAligned: number;
    sigmaHr: number;
    daysLeft: number;
  };

  const rows: Row[] = [];
  for (const m of markets) {
    if (exclude.has(m.slug)) continue;
    if (m.eventSlug && excludeEvents.has(m.eventSlug)) continue;
    if (!m.acceptingOrders || m.clobTokenIds.length < 2) continue;
    if (m.liquidity < R.minLiq || m.volume24h < R.minVol) continue;
    const spreadCeil = Math.min(R.maxSpread, T.maxSpread);
    if (m.spread === null || m.spread > spreadCeil) continue;
    const endMs = m.endDate ? new Date(m.endDate).getTime() : NaN;
    const daysLeft = Number.isNaN(endMs) ? NaN : (endMs - Date.now()) / 86400000;
    if (!(daysLeft > 0.02 && daysLeft <= T.maxDays)) continue;
    if (cfg.domains.length) {
      const dom = m.tags[0] ?? domainKeyFromTitle(m.question);
      if (!cfg.domains.some((d) => dom.toLowerCase().includes(d.toLowerCase()) || m.tags.includes(d))) continue;
    }

    // direction: strongest recent drift; signal override
    const sTop = sigScore.get(m.conditionId)?.top ?? null;
    let outcomeIndex: number;
    if (sTop?.outcome && m.outcomes.includes(sTop.outcome) && sTop.side === "BUY") {
      outcomeIndex = m.outcomes.indexOf(sTop.outcome);
    } else {
      const drift = m.delta1h !== 0 ? m.delta1h : m.delta24h;
      outcomeIndex = drift >= 0 ? 0 : 1;
    }
    const price = m.outcomePrices[outcomeIndex] ?? 0;
    const bandLo = cfg.tempo === "SCALP" ? Math.max(R.priceBand[0], 0.2) : R.priceBand[0];
    const bandHi = cfg.tempo === "SCALP" ? Math.min(R.priceBand[1], 0.8) : R.priceBand[1];
    if (price < bandLo || price > bandHi) continue;

    const dirSign: 1 | -1 = outcomeIndex === 0 ? 1 : -1;
    const mom = m.delta1h * dirSign; // signed toward our side
    const dailyRate = (m.delta24h * dirSign) / 24;
    const accel = mom - dailyRate; // last hour vs daily drift-rate
    // hourly volatility, capped so a single noisy print can't make everything a coin-flip
    const sigmaHr = Math.min(
      Math.max(Math.abs(m.delta24h) / Math.sqrt(24), Math.abs(m.delta1h) * 0.6, 0.006),
      0.05,
    );
    const fl = flow.get(m.conditionId);

    rows.push({
      m,
      outcomeIndex,
      price,
      dirSign,
      momentum: mom,
      accel,
      turnover: m.volume24h / Math.max(m.liquidity, 1),
      logVol: Math.log10(Math.max(m.volume24h, 1)),
      spreadQ: -(m.spread / Math.max(price * (1 - price), 0.05)), // spread relative to variance capacity
      sig: sigScore.get(m.conditionId)?.score ?? 0,
      sigTop: sTop,
      flowAligned: fl === undefined ? 0 : fl * dirSign,
      sigmaHr,
      daysLeft,
    });
  }

  // --- stage 2: cross-sectional z-scores -------------------------------------
  const zs = (xs: number[]) => {
    const { mean, std } = meanStd(xs);
    return xs.map((x) => winsor((x - mean) / std));
  };
  const zMom = zs(rows.map((r) => r.momentum));
  const zAcc = zs(rows.map((r) => r.accel));
  const zTurn = zs(rows.map((r) => r.turnover));
  const zVol = zs(rows.map((r) => r.logVol));
  const zSpr = zs(rows.map((r) => r.spreadQ));

  const w = R.weights;
  const feeRate = feeRateBps / 10_000;

  // pass 1: composite alpha for every filtered row
  const alphas = rows.map((r, i) =>
    w.momentum * zMom[i] +
    w.accel * zAcc[i] +
    w.turnover * zTurn[i] +
    w.volume * zVol[i] +
    w.spreadQ * zSpr[i] +
    w.signal * (r.sig * 3) + // signal score 0..1 → up to ~3σ-equivalent
    w.flow * (r.flowAligned * 2),
  );
  // confidence = percentile rank within THIS sweep (0..10), so a floor of 8
  // means "top 20% of the current universe" and the desk is never starved.
  const sortedAlphas = [...alphas].sort((x, y) => x - y);
  const pctl = (a: number) => {
    if (sortedAlphas.length < 2) return 10;
    let lo = 0;
    let hi = sortedAlphas.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedAlphas[mid] <= a) lo = mid + 1;
      else hi = mid;
    }
    return (lo / sortedAlphas.length) * 10;
  };

  const decisions: DeskDecision[] = [];
  let evPositive = 0;
  let smartCount = 0;

  rows.forEach((r, i) => {
    const alpha = alphas[i];
    const confidence = Math.round(pctl(alpha) * 10) / 10;
    if (confidence < cfg.minConfidence) return;

    // --- live spot + futures alignment for crypto/gold-linked markets -------
    //  never fade the real tape: counter-trend positions are vetoed, aligned
    //  ones earn a drift boost (+ extra when perp funding agrees), and a FLAT
    //  tape passes through on market-native signals instead of being vetoed
    //  (a flat veto was silently killing every BTC up/down entry).
    const spot = cryptoAlignment(r.m.question, r.m.outcomes[r.outcomeIndex] ?? "", cryptoRows);
    if (spot && spot.dir === "against") return;
    // --- elite operator flow: a fresh BUY from a ≥90%-win wallet ------------
    const smart = smartBuys[`${r.m.conditionId}:${(r.m.outcomes[r.outcomeIndex] ?? "").toLowerCase()}`];
    const spotBoost = spot?.dir === "with" ? 0.9 + (spot.fundingAgree ? 0.4 : 0) : 0;
    const alphaAdj = alpha + spotBoost + (smart ? 1.2 : 0);

    // --- market friction (price units per share) ----------------------------
    //  entry crosses the book (taker); winners exit on a resting limit (no
    //  cross), losers/time-outs market out. Blended exit ≈ 0.5×spread.
    //  Polymarket's taker fee is 0% for this builder, so the EV gate is driven
    //  by the true market cost — the spread. The SENTRY platform fee is a
    //  separate layer deducted from realized P&L, never gating whether a setup
    //  is tradeable.
    const platformFeeCost = feeRate * r.price * 2; // informational
    const spreadCost = (r.m.spread ?? 0) * 0.5;
    const cost = spreadCost + 0.001; // spread + 0.1¢ protocol/rounding buffer

    // --- adaptive barriers: TP must clear cost with margin ------------------
    const bBase = (cfg.takeProfitPct / 100) * r.price;
    // TP must clear the FULL round trip (enter at ask, exit at bid) plus a
    // 0.2¢ buffer — half-spread targets “won” on the mid but sold red at the bid
    const b = Math.max(bBase, cost * 1.2, (r.m.spread ?? 0) + 0.002);
    const a = (cfg.stopLossPct / 100) * r.price; // SL distance
    const muHr = Math.max(0, alphaAdj) * T.driftPerZ * r.sigmaHr;
    const { pWin, holdHr } = barrierModel(a, b, muHr, r.sigmaHr);
    const expHoldMin = Math.min(Math.max(holdHr * 60, 3), cfg.maxHoldMin, r.daysLeft * 1440);

    const grossEv = pWin * b - (1 - pWin) * a; // per share, price units
    const netEv = grossEv - cost;
    const evCents = netEv * 100;
    const hasRealSignal = r.momentum >= 0.008 || r.sig > 0 || spot?.dir === "with" || !!smart;
    const isEligible = netEv > 0 && hasRealSignal;
    if (isEligible) evPositive++;
    if (smart) smartCount++;

    const tpFrac = b / r.price;
    const slFrac = cfg.stopLossPct / 100;

    // --- Kelly-lite sizing ---------------------------------------------------
    const kelly = Math.max(0, (netEv / a) * R.kellyFraction);
    const rawSize = Math.min(kelly, 0.08) * equityUsd;
    const sizeUsd = Math.round(Math.min(Math.max(rawSize, cfg.minTradeUsd), cfg.maxTradeUsd));

    const evPerHourUsd = (netEv / r.price) * sizeUsd / Math.max(expHoldMin / 60, 0.05);

    const reasons: string[] = [
      `α ${alpha.toFixed(2)}σ — top ${(100 - confidence * 10).toFixed(0)}% of ${rows.length} filtered markets`,
      `P(TP before SL) ${(pWin * 100).toFixed(0)}% · σ ${(r.sigmaHr * 100).toFixed(1)}¢/√h · drift ${(muHr * 100).toFixed(2)}¢/h`,
      `EV ${evCents >= 0 ? "+" : ""}${evCents.toFixed(2)}¢/sh net of ${(spreadCost * 100).toFixed(1)}¢ spread (market cost) · SENTRY fee ${(platformFeeCost * 100).toFixed(2)}¢ deducted from P&L`,
      `TP ${(tpFrac * 100).toFixed(1)}% (${(b * 100).toFixed(1)}¢, clears cost) · SL ${cfg.stopLossPct}% · hold ~${Math.round(expHoldMin)}m · resolves ${r.daysLeft.toFixed(1)}d`,
    ];
    if (Math.abs(zMom[i]) > 0.8) reasons.push(`momentum z ${zMom[i].toFixed(1)} (1h ${(r.momentum * 100).toFixed(1)}pp toward ${r.m.outcomes[r.outcomeIndex]})`);
    if (Math.abs(zAcc[i]) > 0.8) reasons.push(`acceleration z ${zAcc[i].toFixed(1)} — last hour outpacing daily drift`);
    if (r.sigTop) reasons.push(`${r.sigTop.type.replaceAll("_", " ")} signal (${r.sigTop.severity}) active`);
    if (Math.abs(r.flowAligned) > 0.25) reasons.push(`tape flow ${(r.flowAligned * 100).toFixed(0)}% aligned (30m order-flow imbalance)`);
    if (zTurn[i] > 0.8) reasons.push(`turnover z ${zTurn[i].toFixed(1)} — ${r.turnover.toFixed(1)}× book/24h`);
    if (spot?.dir === "with") reasons.push(`LIVE SPOT ${spot.sym} 15m ${(spot.ret15m * 100).toFixed(2)}% — aligned with position${spot.fundingAgree ? " · PERP FUNDING AGREES (futures tape)" : ""}`);
    if (smart) reasons.push(`ELITE FLOW — ${smart.name} (${Math.round(smart.winRate * 100)}% WIN, settled) bought ${smart.outcome} @ ${(smart.price * 100).toFixed(0)}¢`);
    if (netEv > 0 && !hasRealSignal) reasons.push(`passed — positive EV but no confirming signal (momentum/flow/spot); not eligible`);

    decisions.push({
      id: `AI-${r.m.conditionId.slice(2, 8)}-${r.outcomeIndex}`,
      ts: nowSec,
      slug: r.m.slug,
      question: r.m.question,
      conditionId: r.m.conditionId,
      eventSlug: r.m.eventSlug,
      tokenId: r.m.clobTokenIds[r.outcomeIndex],
      outcomeIndex: r.outcomeIndex,
      outcome: r.m.outcomes[r.outcomeIndex] ?? "YES",
      side: "BUY",
      price: r.price,
      sizeUsd,
      alpha,
      score: Math.max(0, Math.min(10, 5 + alpha * 1.6)),
      confidence,
      pWin,
      evCents,
      evPerHourUsd,
      expHoldMin,
      tpFrac,
      slFrac,
      eligible: isEligible,
      reasons,
      aiVerdict: null,
      aiNote: null,
      status: "PROPOSED",
    });
  });

  // --- stage 3: portfolio plan — round-robin across domains for maximum
  // variety, best EV/hour first within each domain, one position per event ---
  const eligible = decisions
    .filter((d) => d.eligible)
    .sort((x, y) => y.evPerHourUsd - x.evPerHourUsd);

  const byDomain = new Map<string, DeskDecision[]>();
  for (const d of eligible) {
    const dom = domainKeyFromTitle(d.question);
    const arr = byDomain.get(dom);
    if (arr) arr.push(d);
    else byDomain.set(dom, [d]);
  }
  const domCap = Math.max(2, Math.ceil(cfg.maxPositions * 0.4));
  const planCap = Math.min(openSlots, T.entriesPerCycle * 3);
  const evUsed = new Set<string>();
  const domCount = new Map<string, number>();
  const planned: DeskDecision[] = [];
  const queues = [...byDomain.values()];
  let progress = true;
  while (planned.length < planCap && progress) {
    progress = false;
    for (const q of queues) {
      if (planned.length >= planCap) break;
      while (q.length) {
        const d = q.shift()!;
        const dom = domainKeyFromTitle(d.question);
        if ((domCount.get(dom) ?? 0) >= domCap) break;
        if (d.eventSlug && evUsed.has(d.eventSlug)) continue;
        domCount.set(dom, (domCount.get(dom) ?? 0) + 1);
        if (d.eventSlug) evUsed.add(d.eventSlug);
        planned.push(d);
        progress = true;
        break;
      }
    }
  }
  const plannedIds = new Set(planned.map((d) => d.id));

  // feed order: planned first (by ev/hr), then remaining qualifiers by alpha
  const ordered = [
    ...planned,
    ...decisions.filter((d) => !plannedIds.has(d.id)).sort((x, y) => y.evCents - x.evCents),
  ].slice(0, 24);

  return {
    decisions: ordered,
    scan: {
      universe: markets.length,
      filtered: rows.length,
      qualifiers: decisions.length,
      evPositive,
      plannedThisCycle: Math.min(planned.length, T.entriesPerCycle, openSlots),
      avgHoldMin: planned.length ? planned.reduce((s, d) => s + d.expHoldMin, 0) / planned.length : 0,
      smart: smartCount,
      scannedAt: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// Claude overlay
// ---------------------------------------------------------------------------

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          go: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["id", "go", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

export async function claudeReview(
  decisions: DeskDecision[],
  cfg: DeskConfig,
): Promise<{ id: string; go: boolean; note: string }[]> {
  const client = new Anthropic({ apiKey: cfg.anthropicKey, dangerouslyAllowBrowser: true });
  const brief = decisions.map((d) => ({
    id: d.id,
    market: d.question,
    position: `BUY ${d.outcome} @ ${(d.price * 100).toFixed(1)}¢`,
    size_usd: d.sizeUsd,
    alpha_sigma: Number(d.alpha.toFixed(2)),
    p_win: Number(d.pWin.toFixed(2)),
    ev_cents_net: Number(d.evCents.toFixed(2)),
    expected_hold_min: Math.round(d.expHoldMin),
    factors: d.reasons,
  }));

  const response = await client.messages.create({
    model: cfg.anthropicModel,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA as unknown as Record<string, unknown> } },
    messages: [
      {
        role: "user",
        content:
          `You are the risk officer of a prediction-market trading desk running a ${cfg.tempo} book under a ${cfg.risk} profile. ` +
          `A statistical engine proposed these positions (cross-sectional z-factors, barrier-model EV net of costs). ` +
          `Veto on reasoning quality: momentum into likely mean-reversion, stale catalysts, in-game noise the model can't price, crowded extremes. ` +
          `Approve coherent multi-factor cases. One concise sentence per verdict.\n\n` +
          JSON.stringify(brief, null, 1),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("empty AI response");
  const parsed = JSON.parse(text.text) as { verdicts: { id: string; go: boolean; note: string }[] };
  return parsed.verdicts;
}

// ---------------------------------------------------------------------------
// THE ENGINE — mounted once in the workspace shell
// ---------------------------------------------------------------------------

export function useAiDeskEngine() {
  const desk = useAiDesk();
  const { config, engaged, decisions, paper } = desk;
  const tempo = TEMPO_PARAMS[config.tempo];
  const { data: universe } = useDeskUniverse(tempo.scanMs);
  const signals = useSignals((s) => s.signals);
  const tape = useTape((s) => s.trades);
  const notify = useNotifications((s) => s.push);
  const quote = useBilling((s) => s.quote);
  const accrue = useBilling((s) => s.accrue);
  const billingTierRateBps = useBilling((s) => s.quote("SIGNAL", 10_000).rateBps);
  const stage = useTicket((s) => s.stage);
  const ticketOpen = useTicket((s) => s.open);
  const orders = useOrderLog((s) => s.orders);

  const opening = useRef(false);
  const closing = useRef(false);
  const slBreach = useRef(new Map<string, number>()); // posId → consecutive SL ticks
  const startLiveRef = useLiveRef((s) => s.start);
  const cryptoRows = useLiveRef((s) => s.rows);
  const startSmartFlow = useSmartFlow((s) => s.start);
  const smartBuys = useSmartFlow((s) => s.buys);
  // LIVE bankroll is REAL on-chain money — CLOB v2 executes from the
  // Polymarket Deposit Wallet, so once it's linked we read ITS balances
  // (USDC.e + pUSD, the v2 collateral) instead of the EOA's
  const { address: liveAddress } = useAccount();
  const liveTarget = liveAddress ? (cachedDepositWallet(liveAddress) ?? liveAddress) : undefined;
  const { data: liveBalRaw } = useReadContracts({
    contracts: liveTarget
      ? [
          { address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [liveTarget] },
          { address: PUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [liveTarget] },
        ]
      : [],
    query: { enabled: config.executionMode === "LIVE" && !!liveTarget, refetchInterval: 15_000 },
  });
  const liveUsdc =
    liveBalRaw && (liveBalRaw[0]?.result !== undefined || liveBalRaw[1]?.result !== undefined)
      ? Number(((liveBalRaw[0]?.result as bigint | undefined) ?? 0n) + ((liveBalRaw[1]?.result as bigint | undefined) ?? 0n)) / 1e6
      : null;

  useEffect(() => {
    startLiveRef();
    startSmartFlow();
  }, [startLiveRef, startSmartFlow]);
  const aiBusy = useRef(false);
  const lastAiReview = useRef(0);

  const watchedTokens = [
    ...paper.positions.map((p) => p.tokenId),
    ...desk.liveExecuted.map((e) => e.tokenId),
  ];
  useLiveTokens(watchedTokens);
  const quotes = usePrices((s) => s.quotes);

  const markOf = (tokenId: string, fallback: number): number => {
    const q = quotes[tokenId];
    if (q?.bid != null && q?.ask != null) return (q.bid + q.ask) / 2; // mid — immune to spread bounce
    if (q?.last != null) return q.last;
    if (q?.bid != null) return q.bid;
    if (universe) {
      for (const m of universe) {
        const i = m.clobTokenIds.indexOf(tokenId);
        if (i >= 0) return m.outcomePrices[i] ?? fallback;
      }
    }
    return fallback;
  };

  // effective config: FREE WILL derives all sizing/risk knobs from live equity
  const liveEquity =
    config.executionMode === "PAPER" && paper.active
      ? paperEquity(paper, markOf)
      : Math.min(liveUsdc ?? config.budgetUsd, config.budgetUsd);
  const effCfg = effectiveDeskConfig(config, liveEquity, paper.startingCapital || config.startingCapitalUsd);

  // ---- statistical sweep ----------------------------------------------------
  useEffect(() => {
    if (!engaged || !universe?.length) return;
    const st = useAiDesk.getState();
    const nowSec = Math.floor(Date.now() / 1000);
    // block only what's genuinely unavailable: currently-open positions, live
    // in-flight orders, and markets closed within a 45s cooldown (so we don't
    // immediately re-lose right after a stop-out). Everything else is fair game
    // for re-entry — this is the churn engine.
    const exclude = new Set<string>([
      ...st.decisions.filter((d) => d.status === "STAGED").map((d) => d.slug),
      ...st.paper.positions.map((p) => p.slug),
      ...st.liveExecuted.map((e) => e.slug),
      ...st.paper.closed
        .filter((c) => (c.reason === "STOP_LOSS" || c.reason === "TIME_EXIT") && nowSec - c.closedTs < 45)
        .map((c) => c.slug),
    ]);
    const excludeEvents = new Set<string>(
      st.paper.positions.map((p) => {
        const d = st.decisions.find((x) => x.slug === p.slug);
        return d?.eventSlug ?? "";
      }).filter(Boolean),
    );
    const equity = config.executionMode === "PAPER" && st.paper.active
      ? paperEquity(st.paper, markOf)
      : Math.min(liveUsdc ?? config.budgetUsd, config.budgetUsd);
    const openSlots = Math.max(0, effCfg.maxPositions - (config.executionMode === "PAPER" ? st.paper.positions.length : st.liveExecuted.length));
    const { decisions: fresh, scan } = sweepUniverse(
      universe, signals, tape, effCfg, billingTierRateBps, equity, exclude, excludeEvents, openSlots, cryptoRows, smartBuys,
    );
    desk.replaceProposals(fresh, scan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, universe, signals, config]);

  // ---- Claude overlay -------------------------------------------------------
  useEffect(() => {
    if (!engaged || !config.claudeEnabled || !config.anthropicKey || aiBusy.current) return;
    const pending = decisions.filter((d) => d.status === "PROPOSED" && d.aiVerdict === null && d.evCents > 0);
    if (!pending.length || Date.now() - lastAiReview.current < 90_000) return;
    aiBusy.current = true;
    lastAiReview.current = Date.now();
    desk.setAiStatus("CLAUDE REVIEWING PROPOSALS…");
    claudeReview(pending.slice(0, 8), config)
      .then((verdicts) => {
        desk.applyAiVerdicts(verdicts);
        desk.setAiStatus(`CLAUDE REVIEWED ${verdicts.length} — ${verdicts.filter((v) => !v.go).length} VETOED`);
      })
      .catch((e) => desk.setAiStatus(`AI OVERLAY FAULT — ${e instanceof Error ? e.message.slice(0, 80) : "unknown"}`))
      .finally(() => {
        aiBusy.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, decisions, config]);

  // ---- PAPER: autonomous multi-entry against the real book ------------------
  useEffect(() => {
    if (!engaged || config.executionMode !== "PAPER" || !paper.active || opening.current) return;
    const slots = effCfg.maxPositions - paper.positions.length;
    if (slots <= 0 || paper.cash < effCfg.minTradeUsd) return;
    // gradual deployment: dollars in the market are capped by the ladder —
    // it expands only as realized profit accrues, and contracts in drawdown
    const realized = paper.closed.reduce((s, t) => s + t.pnl, 0);
    const capFrac = deployCapFrac(realized, paper.startingCapital);
    const deployedCost = paper.positions.reduce((s, p) => s + p.costUsd, 0);
    // ladder budget floored at two min-clips: a manual MIN TRADE larger than
    // the drawdown ladder (e.g. $100 min on a $1K bank at the 8% floor) must
    // never deadlock the desk at zero open positions
    const ladderUsd = Math.max(
      capFrac * paper.startingCapital,
      Math.min(2 * effCfg.minTradeUsd, 0.5 * paper.startingCapital),
    );
    let headroom = ladderUsd - deployedCost;
    if (headroom < effCfg.minTradeUsd) return;
    const perCycle = realized < -0.02 * paper.startingCapital ? Math.max(1, Math.floor(tempo.entriesPerCycle / 2)) : tempo.entriesPerCycle;
    const batch = decisions
      .filter((d) => d.status === "PROPOSED" && d.eligible && d.aiVerdict !== "VETO" && (!config.claudeEnabled || d.aiVerdict === "GO"))
      .sort((x, y) => y.evPerHourUsd - x.evPerHourUsd)
      .slice(0, Math.min(perCycle, slots));
    if (!batch.length) return;

    opening.current = true;
    (async () => {
      try {
        let cash = useAiDesk.getState().paper.cash;
        for (const next of batch) {
          if (cash < effCfg.minTradeUsd || headroom < effCfg.minTradeUsd) break;
          try {
            const book = await fetchOrderBook(next.tokenId);
            const stats = bookStats(book);
            // DEPTH-AWARE sizing: only take dollars fillable within 1% of the
            // best ask, and never more than half of that tight depth. A $1,000
            // clip walking a thin esports book was the -9% instant-markout bug.
            let tightDepth = 0;
            if (stats.bestAsk !== null) {
              for (const lvl of stats.asks) {
                if (lvl.price > stats.bestAsk * 1.01) break;
                tightDepth += lvl.price * lvl.size;
              }
            }
            const spend = Math.min(next.sizeUsd, cash * 0.9, headroom, tightDepth * 0.5);
            if (spend < effCfg.minTradeUsd) {
              useAiDesk.getState().setDecisionStatus(next.id, "SKIPPED");
              continue;
            }
            const fill = estimateFill(stats.asks, spend);
            // walk guard: never pay more than 1% above the QUOTED best ask —
            // crossing the spread is normal cost (already in the EV model);
            // walking deeper into the book is the instant-markout bug
            const askRef = stats.bestAsk ?? fill.avgPrice;
            if (fill.shares <= 0 || fill.avgPrice <= 0 || fill.avgPrice > askRef * 1.01) {
              useAiDesk.getState().setDecisionStatus(next.id, "SKIPPED");
              continue;
            }
            const fee = quote("SIGNAL", fill.filledUsd);
            // anchor barriers to the entry MID: the crossed half-spread is a
            // sunk cost, not an adverse price move — anchoring to the fill
            // price was the overnight stop-out bug
            const entryMid =
              stats.bestBid !== null && stats.bestAsk !== null
                ? (stats.bestBid + stats.bestAsk) / 2
                : fill.avgPrice;
            const pos: PaperPosition = {
              id: `PP-${Date.now().toString(36)}-${pidSeq++}`,
              decisionId: next.id,
              slug: next.slug,
              question: next.question,
              tokenId: next.tokenId,
              outcome: next.outcome,
              entryPrice: fill.avgPrice,
              shares: fill.shares,
              costUsd: fill.filledUsd,
              feeUsd: fee.feeUsd,
              ts: Math.floor(Date.now() / 1000),
              tpPrice: Math.min(0.99, entryMid * (1 + next.tpFrac)),
              slPrice: Math.max(0.01, entryMid * (1 - next.slFrac)),
              deadline: Math.floor(Date.now() / 1000) + effCfg.maxHoldMin * 60,
            };
            useAiDesk.getState().paperOpen(pos);
            cash -= fill.filledUsd + fee.feeUsd;
            headroom -= fill.filledUsd;
            notify({
              kind: "ORDER",
              title: "AI DESK — PAPER FILL",
              body: `BUY ${pos.outcome} · ${next.question.slice(0, 56)} — ${fill.shares.toFixed(0)} sh @ ${(fill.avgPrice * 100).toFixed(1)}¢`,
              href: "/ai",
            });
          } catch {
            /* book unavailable — next candidate */
          }
        }
      } finally {
        opening.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, config, paper, decisions]);

  // ---- PAPER: exit management (TP / SL / time) — keeps running while any
  // position exists, even after the session is stood down (positions must
  // never freeze unmanaged) -------------------------------------------------
  useEffect(() => {
    if (!paper.positions.length) return;
    const tick = async () => {
      if (closing.current) return;
      closing.current = true;
      try {
        const now = Math.floor(Date.now() / 1000);
        const open = useAiDesk.getState().paper.positions;
        // marks come from the LIVE book, fetched in parallel — WS quotes are
        // absent for quiet tokens, and a mark frozen at entry means SL/TP
        // never fire and the position dumps at deadline instead
        const books = await Promise.all(
          open.map((p) => fetchOrderBook(p.tokenId).then(bookStats).catch(() => null)),
        );
        for (let i = 0; i < open.length; i++) {
          const p = open[i];
          const stats = books[i];
          const mark =
            stats && stats.bestBid !== null && stats.bestAsk !== null
              ? (stats.bestBid + stats.bestAsk) / 2
              : markOf(p.tokenId, p.entryPrice);
          const hitTp = mark >= p.tpPrice;
          const hitTime = now >= p.deadline;
          // stop-loss needs TWO consecutive breaching ticks (~8s) of the real
          // book mid — a single wobble or shallow red never insta-cancels
          let hitSl = false;
          if (mark <= p.slPrice) {
            const n = (slBreach.current.get(p.id) ?? 0) + 1;
            slBreach.current.set(p.id, n);
            hitSl = n >= 2;
          } else {
            slBreach.current.delete(p.id);
          }
          if (!hitTp && !hitSl && !hitTime) continue;
          if (!stats) continue; // book unavailable — retry next tick
          const sell = estimateSell(stats.bids, p.shares);
          const exitPrice = sell.filledShares > 0 ? sell.avgPrice : mark;
          const proceeds = sell.filledShares > 0 ? sell.proceedsUsd : mark * p.shares;
          const exitFee = quote("SIGNAL", proceeds).feeUsd;
          const reason = hitTp ? "TAKE_PROFIT" : hitSl ? "STOP_LOSS" : "TIME_EXIT";
          // a take-profit must be REAL: if selling into the actual bids nets a
          // loss, hold — the mid ran ahead of exit liquidity. Stop-loss and
          // the deadline still guard the downside.
          if (reason === "TAKE_PROFIT" && proceeds - exitFee - p.costUsd - p.feeUsd <= 0) continue;
          slBreach.current.delete(p.id);
          useAiDesk.getState().paperClose(p.id, exitPrice, proceeds, exitFee, reason);
          const pnl = proceeds - exitFee - p.costUsd - p.feeUsd;
          notify({
            kind: "ORDER",
            title: `AI DESK — ${reason.replaceAll("_", " ")}`,
            body: `${p.question.slice(0, 56)} — ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} net`,
            href: "/ai",
          });
        }
      } catch {
        /* transient network fault — retry next tick */
      } finally {
        closing.current = false;
      }
    };
    const t = setInterval(() => void tick(), 4_000);
    void tick();
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.positions.length, universe]);

  // ---- session halts --------------------------------------------------------
  useEffect(() => {
    if (!engaged) return;
    if (config.executionMode === "PAPER" && paper.active) {
      const equity = paperEquity(paper, markOf);
      const pnl = equity - paper.startingCapital;
      if (pnl >= config.targetProfitUsd) {
        desk.setHalt(`TARGET REACHED — +$${pnl.toFixed(2)} ON PAPER · DESK STANDBY`);
        notify({ kind: "SYSTEM", title: "AI DESK — TARGET REACHED", body: `Paper session closed at +$${pnl.toFixed(2)} net of fees.`, href: "/ai" });
      } else if (pnl <= -effCfg.maxLossUsd) {
        desk.setHalt(`LOSS BRAKE — $${pnl.toFixed(2)} (LIMIT $${effCfg.maxLossUsd}) · DESK STANDBY`);
      }
    }
    if (config.executionMode === "LIVE" && desk.liveBaseline !== null && liveUsdc !== null) {
      const pnl = liveUsdc - desk.liveBaseline;
      if (pnl >= config.targetProfitUsd) {
        desk.setHalt(`TARGET REACHED — +$${pnl.toFixed(2)} LIVE (WALLET-MEASURED) · DESK STANDBY`);
        notify({ kind: "SYSTEM", title: "AI DESK — LIVE TARGET REACHED", body: `Wallet is up $${pnl.toFixed(2)} since engage.`, href: "/ai" });
      } else if (pnl <= -effCfg.maxLossUsd) {
        desk.setHalt(`LOSS BRAKE — $${pnl.toFixed(2)} LIVE (LIMIT $${effCfg.maxLossUsd}) · DESK STANDBY`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, paper, quotes, config, liveUsdc]);

  // LIVE baseline: wallet balance snapshot at engage; cleared on stand-down —
  // the target is measured against REAL money, deposits mid-session skew it
  useEffect(() => {
    if (engaged && config.executionMode === "LIVE" && liveUsdc !== null && desk.liveBaseline === null) {
      desk.setLiveBaseline(liveUsdc);
    }
    if (!engaged && desk.liveBaseline !== null) {
      desk.setLiveBaseline(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, config.executionMode, liveUsdc]);

  // ---- LIVE: ARM auto-staging + order-log linking ---------------------------
  useEffect(() => {
    if (!engaged || config.executionMode !== "LIVE" || config.mode !== "ARM" || ticketOpen) return;
    if (desk.liveExecuted.length >= config.maxPositions) return;
    const next = decisions
      .filter((d) => d.status === "PROPOSED" && d.eligible && d.evCents > 0 && d.aiVerdict !== "VETO" && (!config.claudeEnabled || d.aiVerdict === "GO"))
      .filter((d) => liveUsdc === null || d.sizeUsd <= liveUsdc)
      .sort((x, y) => y.evPerHourUsd - x.evPerHourUsd)[0];
    if (!next || !universe) return;
    const market = universe.find((m) => m.slug === next.slug);
    if (!market) return;
    const t = setTimeout(() => {
      stage(market, next.outcomeIndex, "BUY", next.sizeUsd, "SIGNAL", null, true);
      desk.setDecisionStatus(next.id, "STAGED");
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, config, ticketOpen, decisions, universe]);

  useEffect(() => {
    const staged = decisions.filter((d) => d.status === "STAGED");
    if (!staged.length) return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const d of staged) {
      if (config.executionMode === "LIVE" && nowSec - d.ts > 180 && !orders.some((o) => o.slug === d.slug && Date.now() - o.ts < 5 * 60_000)) {
        desk.setDecisionStatus(d.id, "SKIPPED");
      }
    }
    if (!orders.length) return;
    for (const d of staged) {
      const match = orders.find((o) => o.slug === d.slug && !o.error && Date.now() - o.ts < 5 * 60_000);
      if (match) {
        desk.recordLiveExecution({
          decisionId: d.id,
          ts: Math.floor(match.ts / 1000),
          slug: d.slug,
          question: d.question,
          tokenId: d.tokenId,
          outcome: d.outcome,
          entryPrice: match.price,
          usd: match.usd,
          shares: match.shares,
        });
        accrue(quote("SIGNAL", match.usd), { market: d.question, notionalUsd: match.usd });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, decisions]);
}
