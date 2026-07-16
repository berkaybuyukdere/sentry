import { useEffect, useRef } from "react";
import { useAccount, useReadContracts, useWalletClient } from "wagmi";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import Anthropic from "@anthropic-ai/sdk";
import {
  fetchOrderBook,
  fetchMarketBySlug,
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
import { USDC, PUSD, ERC20_ABI, POLY_PROXY_WALLET } from "./trading/constants";
import { cachedDepositWallet } from "./trading/v2client";
import { useSessionSigner, sessionAddress, sessionWalletClient } from "./trading/sessionSigner";
import { signAndPlaceOrder, snapToTick } from "./trading/orders";
import { readCtfShareBalance } from "./trading/ctfBalance";
import { sendLiveMail, type LiveMailKpi } from "./liveMail";

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
  /** AUTO bankroll: ignore budgetUsd and track the full wallet balance —
   *  as profits land, clip sizing and deployment grow with the bank
   *  ("hacim arttıkça bahis de artsın"). FREE WILL clips stay 0.2–3% of
   *  equity, so growth compounds without a manual budget bump. */
  budgetAuto: boolean;
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
  /** set when this entry copies a tracked elite operator's fresh BUY —
   *  "name (winRate%)". Copy trades bypass the selectivity floor and rank
   *  first, but still respect the EV>0 gate (never copy into a bad spread). */
  copy: string | null;
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
  /** highest mark seen — drives the trailing stop once the position clears
   *  the profit-activation level (tpPrice). Winners are not capped; they run
   *  until the trail is hit or the market resolves. */
  peakMark?: number;
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

export interface LiveExecution {
  decisionId: string;
  ts: number;
  slug: string;
  question: string;
  tokenId: string;
  outcome: string;
  entryPrice: number;
  usd: number;
  shares: number;
  tickSize: number;
  negRisk: boolean;
  costUsd: number;
  feeUsd: number;
  tpPrice: number;
  slPrice: number;
  deadline: number; // unix seconds
  /** persisted before exit management existed; exits stay dormant until the
   *  first live mark rebases TP/SL/deadline off REALITY, not the old entry */
  migrated?: boolean;
  /** unix seconds of the one-time rebase for migrated positions */
  rebasedTs?: number;
  /** lowercase EOA that OPENED the position — exits must sign with the same
   *  identity (its proxy holds the shares). Absent on pre-autopilot records,
   *  which all belonged to the main Phantom account. */
  owner?: string;
  /** highest mark seen — drives the trailing stop once the position clears
   *  tpPrice. Winners run uncapped until the trail is hit or the market
   *  resolves; the trail ratchets up and never lets a winner become a loss. */
  peakMark?: number;
}

export interface LiveClosedTrade {
  decisionId: string;
  ts: number;
  slug: string;
  question: string;
  outcome: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  costUsd: number;
  feeUsd: number;
  exitFee: number;
  pnl: number;
  reason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT" | "MANUAL" | "RESOLVED";
  closedTs: number;
  /** lowercase EOA that owned the position — realized P&L is per-identity */
  owner?: string;
  /** RESOLVED trades settle on-chain: the operator collects by redeeming on
   *  Polymarket (or the payout auto-credits). Flagged so the UI can prompt. */
  awaitingRedeem?: boolean;
}

interface DeskState {
  config: DeskConfig;
  engaged: boolean;
  haltReason: string | null;
  liveBaseline: number | null; // wallet USDC.e at LIVE engage — target/loss anchor
  /** Profit-lock ladder: banked LIVE profit (absolute $) the desk may never
   *  re-risk. Raised as session P&L crosses 25/50/75% of target (locking half
   *  of each rung); entries are cash-floored at baseline+locked and the desk
   *  stands down if P&L falls back to the locked level — banked money stays
   *  banked. Cleared with the baseline on stand-down. */
  lockedProfitUsd: number;
  decisions: DeskDecision[];
  aiStatus: string | null;
  /** why the LIVE autopilot fast-entry pass did or didn't act this cycle —
   *  every early-return states its reason here instead of failing silently */
  liveAutoStatus: string | null;
  paper: PaperSession;
  scan: ScanStats;
  liveExecuted: LiveExecution[];
  liveClosed: LiveClosedTrade[];
  setConfig: (patch: Partial<DeskConfig>) => void;
  setTempo: (t: Tempo) => void;
  setEngaged: (v: boolean) => void;
  setHalt: (reason: string) => void;
  setLiveBaseline: (v: number | null) => void;
  setLockedProfit: (v: number) => void;
  replaceProposals: (d: DeskDecision[], scan: ScanStats) => void;
  setDecisionStatus: (id: string, status: DeskDecision["status"]) => void;
  applyAiVerdicts: (verdicts: { id: string; go: boolean; note: string }[]) => void;
  recordLiveExecution: (r: LiveExecution) => void;
  recordLiveClose: (decisionId: string, exitPrice: number, proceeds: number, exitFee: number, reason: LiveClosedTrade["reason"]) => void;
  /** FAK sells can fill PARTIALLY: ledger the filled slice at its real
   *  proceeds and shrink the open position — treating a partial as a full
   *  close would orphan the unsold shares with no exit management */
  recordLivePartialClose: (decisionId: string, filledShares: number, exitPrice: number, proceeds: number, exitFee: number, reason: LiveClosedTrade["reason"]) => void;
  /** one-time TP/SL/deadline rebase for migrated positions — persisted so it
   *  survives reloads (merge-derived values alone never reach localStorage) */
  rebaseLivePosition: (decisionId: string, patch: Partial<LiveExecution>) => void;
  /** drops a position with zero real on-chain balance — no proceeds are
   *  known, so it is removed WITHOUT a liveClosed entry (never fabricate P&L) */
  writeOffLivePosition: (decisionId: string) => void;
  /** market resolved on-chain — books the settled payout ($1/share if the
   *  held outcome won, else $0) and flags a winner as awaiting redemption */
  recordLiveResolution: (decisionId: string, won: boolean) => void;
  startPaperSession: () => void;
  stopPaperSession: () => void;
  paperOpen: (p: PaperPosition) => void;
  /** persist the running peak on a paper position (trailing-stop anchor) —
   *  survives reload so a winner never silently de-activates */
  setPaperPeak: (positionId: string, peak: number) => void;
  paperClose: (positionId: string, exitPrice: number, proceeds: number, exitFee: number, reason: ClosedTrade["reason"]) => void;
  setAiStatus: (s: string | null) => void;
  setLiveAutoStatus: (s: string | null) => void;
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
  budgetAuto: true,
  minTradeUsd: 2,
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
      lockedProfitUsd: 0,
      decisions: [],
      aiStatus: null,
      liveAutoStatus: null,
      paper: EMPTY_PAPER,
      scan: EMPTY_SCAN,
      liveExecuted: [],
      liveClosed: [],

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
      setLockedProfit: (lockedProfitUsd) => set({ lockedProfitUsd }),

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

      rebaseLivePosition: (decisionId, patch) =>
        set((s) => ({
          liveExecuted: s.liveExecuted.map((e) => (e.decisionId === decisionId ? { ...e, ...patch } : e)),
        })),

      writeOffLivePosition: (decisionId) =>
        set((s) => ({
          liveExecuted: s.liveExecuted.filter((e) => e.decisionId !== decisionId),
        })),

      recordLiveResolution: (decisionId, won) =>
        set((s) => {
          const pos = s.liveExecuted.find((e) => e.decisionId === decisionId);
          if (!pos) return s;
          // resolved value is settled truth: winner redeems each share for $1,
          // loser for $0. No exit fee — redemption is not a CLOB trade. The
          // operator collects the payout by redeeming on Polymarket (or it
          // auto-credits), so the P&L is real but the cash lands on redeem.
          const proceeds = won ? pos.shares : 0;
          const trade: LiveClosedTrade = {
            decisionId,
            ts: pos.ts,
            slug: pos.slug,
            question: pos.question,
            outcome: pos.outcome,
            entryPrice: pos.entryPrice,
            exitPrice: won ? 1 : 0,
            shares: pos.shares,
            costUsd: pos.costUsd,
            feeUsd: pos.feeUsd,
            exitFee: 0,
            pnl: proceeds - pos.costUsd - pos.feeUsd,
            reason: "RESOLVED",
            closedTs: Math.floor(Date.now() / 1000),
            owner: pos.owner,
            awaitingRedeem: won, // losers need no action
          };
          return {
            liveExecuted: s.liveExecuted.filter((e) => e.decisionId !== decisionId),
            liveClosed: [trade, ...s.liveClosed].slice(0, 100),
          };
        }),

      recordLiveClose: (decisionId, exitPrice, proceeds, exitFee, reason) =>
        set((s) => {
          const pos = s.liveExecuted.find((e) => e.decisionId === decisionId);
          if (!pos) return s;
          const pnl = proceeds - exitFee - pos.costUsd - pos.feeUsd;
          const trade: LiveClosedTrade = {
            decisionId,
            ts: pos.ts,
            slug: pos.slug,
            question: pos.question,
            outcome: pos.outcome,
            entryPrice: pos.entryPrice,
            exitPrice,
            shares: pos.shares,
            costUsd: pos.costUsd,
            feeUsd: pos.feeUsd,
            exitFee,
            pnl,
            reason,
            closedTs: Math.floor(Date.now() / 1000),
            owner: pos.owner,
          };
          return {
            liveExecuted: s.liveExecuted.filter((e) => e.decisionId !== decisionId),
            liveClosed: [trade, ...s.liveClosed].slice(0, 100),
          };
        }),

      recordLivePartialClose: (decisionId, filledShares, exitPrice, proceeds, exitFee, reason) =>
        set((s) => {
          const pos = s.liveExecuted.find((e) => e.decisionId === decisionId);
          if (!pos || filledShares <= 0) return s;
          const frac = Math.min(1, filledShares / pos.shares);
          const costSlice = pos.costUsd * frac;
          const feeSlice = pos.feeUsd * frac;
          const trade: LiveClosedTrade = {
            decisionId: `${decisionId}·P${Math.floor(Date.now() / 1000)}`,
            ts: pos.ts,
            slug: pos.slug,
            question: pos.question,
            outcome: pos.outcome,
            entryPrice: pos.entryPrice,
            exitPrice,
            shares: filledShares,
            costUsd: costSlice,
            feeUsd: feeSlice,
            exitFee,
            pnl: proceeds - exitFee - costSlice - feeSlice,
            reason,
            closedTs: Math.floor(Date.now() / 1000),
            owner: pos.owner,
          };
          const remainder = pos.shares - filledShares;
          return {
            liveExecuted:
              remainder < 0.01
                ? s.liveExecuted.filter((e) => e.decisionId !== decisionId)
                : s.liveExecuted.map((e) =>
                    e.decisionId === decisionId
                      ? { ...e, shares: remainder, costUsd: e.costUsd - costSlice, feeUsd: e.feeUsd - feeSlice, usd: e.usd * (1 - frac) }
                      : e,
                  ),
            liveClosed: [trade, ...s.liveClosed].slice(0, 100),
          };
        }),

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

      setPaperPeak: (positionId, peak) =>
        set((s) => ({
          paper: {
            ...s.paper,
            positions: s.paper.positions.map((p) => (p.id === positionId ? { ...p, peakMark: peak } : p)),
          },
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
      setLiveAutoStatus: (liveAutoStatus) => set({ liveAutoStatus }),
      resetDecisions: () => set({ decisions: [], scan: EMPTY_SCAN, haltReason: null }),
    }),
    {
      name: "sentry.aiDesk",
      partialize: (s) => ({ config: s.config, paper: s.paper, liveExecuted: s.liveExecuted.slice(0, 40), liveClosed: s.liveClosed.slice(0, 40) }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DeskState>;
        const paper = { ...EMPTY_PAPER, ...(p.paper ?? {}) };
        // migrate live positions persisted before exit management existed:
        // they lack tp/sl/deadline/cost fields, which would render as NaN in
        // the KPIs and make the exit tick silently skip them. CRITICAL: do NOT
        // stamp live triggers here — an entry-anchored SL on an aged position
        // that has already drifted >slPct fires within seconds of load, and a
        // shared deadline mass-dumps the whole book minutes later (adversarial
        // review caught exactly this against 9 real open positions). Instead:
        // TP is entry-anchored (harmless — TP only closes after a verified
        // net-positive sell), SL is parked at the 1¢ floor (dormant) and the
        // deadline far out; the exit tick REBASES both off the first real
        // mark it sees and persists that via rebaseLivePosition.
        const tempo = TEMPO_PARAMS[p.config?.tempo ?? DEFAULT_CONFIG.tempo];
        const liveExecuted = (p.liveExecuted ?? []).map((e) => ({
          ...e,
          tickSize: e.tickSize ?? 0.01,
          negRisk: e.negRisk ?? false,
          costUsd: e.costUsd ?? e.usd,
          feeUsd: e.feeUsd ?? 0,
          tpPrice: e.tpPrice ?? Math.min(0.99, e.entryPrice * (1 + tempo.tpPct / 100)),
          slPrice: e.slPrice ?? 0.01,
          deadline: e.deadline ?? Math.floor(Date.now() / 1000) + 24 * 3600,
          migrated: e.migrated ?? (e.tpPrice === undefined),
        }));
        return {
          ...current,
          ...p,
          config: { ...DEFAULT_CONFIG, ...(p.config ?? {}) },
          paper,
          scan: EMPTY_SCAN,
          liveExecuted,
          liveClosed: p.liveClosed ?? [],
          lockedProfitUsd: 0, // session-scoped; a reload stands the desk down
          // an active paper session resumes fully autonomous after reload
          engaged: paper.active,
        };
      },
    },
  ),
);

/** FREE-WILL derivation: everything scales from live equity so the same desk
 *  is sane at $30 and at $50,000. Clips 0.2–10% of equity, tempo exits,
 *  loss brake 10% of starting capital. The operator's target is respected.
 *
 *  A prior version floored BOTH minTradeUsd and maxTradeUsd at fixed dollar
 *  amounts ($2 / $4) that only mattered once equity crossed ~$1,000 below
 *  that, every clip collapsed onto the SAME $2–4 band regardless of equity
 *  or conviction — the real Kelly-derived size (which already scales with
 *  edge strength via netEv/a and any copy-trade boost) was being computed
 *  correctly and then thrown away by the floor and whole-dollar rounding.
 *  The only floor that should never move is the CLOB's own minimum notional
 *  (~$1.05 with fee/slippage padding); above that, size differentiation is
 *  real and equity- and conviction-scaled, not a fixed narrow band. */
export function effectiveDeskConfig(cfg: DeskConfig, equity: number, startingCapital: number): DeskConfig {
  if (!cfg.freeWill) return cfg;
  const T = TEMPO_PARAMS[cfg.tempo];
  const eq = Math.max(equity, 10);
  const CLOB_MIN = 1.05; // exchange rejects sub-$1 notionals; padded for fee/slippage shave
  const minTrade = Math.max(CLOB_MIN, eq * 0.002);
  return {
    ...cfg,
    minTradeUsd: minTrade,
    // up to 10% of equity for the single highest-conviction clip — a real
    // ceiling that grows with the account, not a fixed multiple of the floor
    maxTradeUsd: Math.max(minTrade * 3, Math.min(eq * 0.10, 2500)),
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

/**
 * Trailing-stop price for a position that has cleared its profit-activation
 * level. Winners are NOT capped by a fixed take-profit — the stop ratchets up
 * under the running peak and the runner rides toward $1 resolution.
 *
 * The giveback has a MINIMUM BREATHING ROOM of max(2.5¢, 4% of price): right
 * after activation the gain is tiny, and "half the gain" made the trail so
 * tight that ordinary mid-wobble stopped runners out with +$0.05 scraps
 * (observed live) — often below the old fixed TP. With the room floor, the
 * trail starts AT BREAKEVEN (full room to run; the net-positive sell gate
 * means the worst case is a small net-positive scratch, never a loss) and
 * only starts locking profit once the gain outgrows the noise:
 *
 *   entry 0.713, peak 0.742 → trail 0.714 (breakeven — run free)
 *   entry 0.713, peak 0.780 → trail 0.746 (locks ~the old +4% TP)
 *   entry 0.713, peak 0.850 → trail 0.782 (+7¢ locked)
 *   entry 0.713, peak 0.950 → trail 0.855 (+14¢ locked, still riding)
 *
 * The hard stop-loss floor stays armed independently — this function only
 * governs the profit side.
 */
export function trailingStopPrice(entryPrice: number, peakMark: number): number {
  const gain = Math.max(0, peakMark - entryPrice);
  const room = Math.max(0.025, 0.04 * peakMark);
  const giveback = Math.min(Math.max(room, 0.5 * gain), 0.1 * peakMark);
  return Math.max(entryPrice * 1.002, peakMark - giveback);
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
    // --- COPY TRADE: a fresh BUY from a tracked elite operator --------------
    //  Looked up BEFORE the selectivity floor so a copy is never filtered out
    //  by relative alpha ranking — a top wallet's live conviction is a real,
    //  external signal, not something to rank against the noise around it.
    const smart = smartBuys[`${r.m.conditionId}:${(r.m.outcomes[r.outcomeIndex] ?? "").toLowerCase()}`];
    // selectivity floor gates statistical candidates; copies bypass it (the
    // EV>0 gate still applies below, so we never copy into a bad spread)
    if (!smart && confidence < cfg.minConfidence) return;

    // --- live spot + futures alignment for crypto/gold-linked markets -------
    //  never fade the real tape: counter-trend positions are vetoed, aligned
    //  ones earn a drift boost (+ extra when perp funding agrees), and a FLAT
    //  tape passes through on market-native signals instead of being vetoed
    //  (a flat veto was silently killing every BTC up/down entry).
    const spot = cryptoAlignment(r.m.question, r.m.outcomes[r.outcomeIndex] ?? "", cryptoRows);
    if (spot && spot.dir === "against") return;
    // copy weight scales with the operator's MEASURED realized win rate: a
    // 70% wallet adds ~1.0σ, an 87% wallet ~1.85σ, a 90%+ wallet ~2.0σ — so
    // copies rank at/near the top of the fill batch, entered first each cycle.
    const spotBoost = spot?.dir === "with" ? 0.9 + (spot.fundingAgree ? 0.4 : 0) : 0;
    const copyBoost = smart ? Math.min(2.2, 1.0 + Math.max(0, smart.winRate - 0.7) * 5) : 0;
    const alphaAdj = alpha + spotBoost + copyBoost;

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
    // conviction already varies rawSize continuously via netEv/a (edge size)
    // and R.kellyFraction — copy trades and high-alpha setups produce a
    // genuinely bigger kelly fraction than marginal EV+ ones. Rounding to the
    // nearest DIME (not whole dollar) preserves that differentiation instead
    // of collapsing every small-account clip onto the same 2/3/4 buckets.
    const kelly = Math.max(0, (netEv / a) * R.kellyFraction);
    const rawSize = Math.min(kelly, 0.08) * equityUsd;
    const sizeUsd = Math.round(Math.min(Math.max(rawSize, cfg.minTradeUsd), cfg.maxTradeUsd) * 10) / 10;

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
    if (smart) reasons.push(`COPY — ${smart.name} (${Math.round(smart.winRate * 100)}% WIN, settled) bought ${smart.outcome} @ ${(smart.price * 100).toFixed(0)}¢`);
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
      copy: smart ? `${smart.name} (${Math.round(smart.winRate * 100)}%)` : null,
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
  const logOrder = useOrderLog((s) => s.log);

  const opening = useRef(false);
  const closing = useRef(false);
  const slBreach = useRef(new Map<string, number>()); // posId → consecutive SL ticks
  const paperTrailBreach = useRef(new Map<string, number>()); // posId → consecutive trailing-stop breach ticks
  const paperCapitTicks = useRef(new Map<string, number>()); // posId → healthy-book ticks below the SL floor
  const startLiveRef = useLiveRef((s) => s.start);
  const cryptoRows = useLiveRef((s) => s.rows);
  const startSmartFlow = useSmartFlow((s) => s.start);
  const smartBuys = useSmartFlow((s) => s.buys);
  // LIVE bankroll is REAL on-chain money — CLOB v2 executes from the
  // Polymarket Deposit Wallet, so once it's linked we read ITS balances
  // (USDC.e + pUSD, the v2 collateral) instead of the EOA's.
  // AUTOPILOT: when the session signer is armed, the desk's identity IS the
  // session account — its proxy holds the bankroll and its key signs exits —
  // so every read and every order routes through it instead of Phantom.
  const sess = useSessionSigner();
  const { address: phantomAddress } = useAccount();
  // POLY_PROXY_WALLET is confirmed-authorized ONLY for the main EOA — a
  // burner signer linked to it (e.g. the wrong address pasted by hand) can
  // never place an accepted order ("does not match auth"/maker mismatch)
  // every single attempt. Refuse to consider autopilot armed in that state
  // rather than repeatedly signing doomed orders with no visible reason.
  const sessAddrForCheck = sess.pk ? sessionAddress() : null;
  const proxyOwnedByOther =
    !!sess.proxyWallet &&
    sess.proxyWallet.toLowerCase() === POLY_PROXY_WALLET.toLowerCase() &&
    !!sessAddrForCheck &&
    !!phantomAddress &&
    sessAddrForCheck.toLowerCase() !== phantomAddress.toLowerCase();
  const autoOn = sess.enabled && !!sess.pk && !!sess.proxyWallet && !proxyOwnedByOther;
  const liveAddress = autoOn ? (sessionAddress() ?? undefined) : phantomAddress;
  const liveTarget = liveAddress ? (cachedDepositWallet(liveAddress) ?? liveAddress) : undefined;
  // position ownership: exits, P&L and the cash floor are all PER-IDENTITY.
  // Records without an owner predate autopilot — they are Phantom's.
  const ownerOf = (e: LiveExecution): string | null =>
    (e.owner ?? phantomAddress?.toLowerCase()) ?? null;
  const ownedByLive = (e: LiveExecution): boolean =>
    !!liveAddress && ownerOf(e) === liveAddress.toLowerCase();
  const { data: liveBalRaw, dataUpdatedAt: liveBalAsOf } = useReadContracts({
    contracts: liveTarget
      ? [
          { address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [liveTarget] },
          { address: PUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [liveTarget] },
        ]
      : [],
    query: { enabled: config.executionMode === "LIVE" && !!liveTarget, refetchInterval: 10_000 },
  });
  const liveUsdc =
    liveBalRaw && (liveBalRaw[0]?.result !== undefined || liveBalRaw[1]?.result !== undefined)
      ? Number(((liveBalRaw[0]?.result as bigint | undefined) ?? 0n) + ((liveBalRaw[1]?.result as bigint | undefined) ?? 0n)) / 1e6
      : null;
  // the poll is 10s-stale: fills recorded since the last balance read have
  // spent cash the snapshot still shows. Every gate/sizing decision uses this
  // corrected figure — back-to-back ARM fills inside one poll window were
  // able to spend straight through the profit-lock floor otherwise.
  const pendingSpend = desk.liveExecuted
    .filter((e) => ownedByLive(e) && e.ts * 1000 > (liveBalAsOf ?? 0) - 2_000)
    .reduce((s, e) => s + e.costUsd, 0);
  const liveCash = liveUsdc !== null ? Math.max(0, liveUsdc - pendingSpend) : null;

  // KPI snapshot attached to every live e-mail — store reads are fresh by
  // nature; the wallet figure goes through a ref updated every render so a
  // long-lived effect closure (the 5s exit tick) never reports a frozen value
  const liveCashRef = useRef<number | null>(null);
  liveCashRef.current = liveCash;
  const liveMailKpi = (): LiveMailKpi => {
    const st = useAiDesk.getState();
    const cash = liveCashRef.current;
    return {
      walletUsd: cash,
      openCount: st.liveExecuted.length,
      realizedUsd: st.liveClosed.reduce((s, t) => s + t.pnl, 0),
      lockedUsd: st.lockedProfitUsd,
      targetUsd: st.config.targetProfitUsd,
      sessionPnlUsd:
        st.liveBaseline !== null && cash !== null
          ? cash + st.liveExecuted.filter(ownedByLive).reduce((s, e) => s + e.costUsd, 0) - st.liveBaseline
          : null,
    };
  };

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

  // effective config: FREE WILL derives all sizing/risk knobs from live equity.
  // Profit-lock model (LIVE): the cash floor is baseline + locked — the original
  // bank AND every banked dollar are untouchable. While a lock is active the
  // desk sizes and spends ONLY from cash above that floor ("play with half the
  // profit, bank the other half"); with no lock the whole bank plays as before.
  // FAIL CLOSED: if the balance feed drops while a lock is active, playable
  // is 0 — never fall back to budgetUsd with banked profit on the line.
  const locked = desk.lockedProfitUsd;
  const liveCashFloor = locked > 0 && desk.liveBaseline !== null ? desk.liveBaseline + locked : null;
  // AUTO bankroll tracks the whole wallet — realized profit compounds into
  // sizing without a manual budget bump; a fixed budget stays a hard cap
  const budgetCap = config.budgetAuto ? Number.POSITIVE_INFINITY : config.budgetUsd;
  const livePlayable =
    liveCashFloor !== null
      ? liveCash !== null
        ? Math.max(0, Math.min(liveCash - liveCashFloor, budgetCap))
        : 0
      : Math.min(liveCash ?? (config.budgetAuto ? 0 : config.budgetUsd), budgetCap);
  const liveEquity =
    config.executionMode === "PAPER" && paper.active ? paperEquity(paper, markOf) : livePlayable;
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
    const floor = st.lockedProfitUsd > 0 && st.liveBaseline !== null ? st.liveBaseline + st.lockedProfitUsd : null;
    const cap = config.budgetAuto ? Number.POSITIVE_INFINITY : config.budgetUsd;
    const equity = config.executionMode === "PAPER" && st.paper.active
      ? paperEquity(st.paper, markOf)
      : floor !== null
        ? liveCash !== null
          ? Math.max(0, Math.min(liveCash - floor, cap))
          : 0 // fail closed under an active lock
        : Math.min(liveCash ?? (config.budgetAuto ? 0 : config.budgetUsd), cap);
    // slots count only the CURRENT identity's positions — the other account's
    // book (e.g. Phantom's legacy positions while autopilot is armed) must not
    // starve this identity's deployment
    const openSlots = Math.max(0, effCfg.maxPositions - (config.executionMode === "PAPER" ? st.paper.positions.length : st.liveExecuted.filter(ownedByLive).length));
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
      // copies first (a tracked elite operator's live conviction), then EV/hr
      .sort((x, y) => (x.copy ? 0 : 1) - (y.copy ? 0 : 1) || y.evPerHourUsd - x.evPerHourUsd)
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
          // dislocated book (bids pulled → phantom mid collapse): freeze the
          // position this tick — mirrors the LIVE exit tick exactly so paper
          // stays an honest predictor of live behavior
          const pSpread = stats && stats.bestBid !== null && stats.bestAsk !== null ? stats.bestAsk - stats.bestBid : null;
          if (pSpread !== null && pSpread > Math.max(0.1, mark * 0.4)) continue;
          // LET WINNERS RUN (mirrors LIVE): the take-profit is now only an
          // activation level; past it, a ratcheting trailing stop protects the
          // gain and the winner runs uncapped, with no time deadline. Peak is
          // PERSISTED on the position (survives reload) so a running winner
          // never silently de-activates.
          const ppeak = Math.max(p.peakMark ?? p.entryPrice, mark);
          if (ppeak > (p.peakMark ?? p.entryPrice) + 1e-6) useAiDesk.getState().setPaperPeak(p.id, ppeak);
          const pActivated = ppeak >= p.tpPrice;
          const hitTime = !pActivated && now >= p.deadline;
          // HARD STOP FLOOR — always armed, even after activation (a reversed
          // winner is still a stop-loss; the stop-limit band below is gap-safe)
          let hitSl = false;
          if (mark <= p.slPrice) {
            const n = (slBreach.current.get(p.id) ?? 0) + 1;
            slBreach.current.set(p.id, n);
            hitSl = n >= 2;
          } else {
            slBreach.current.delete(p.id);
          }
          // TRAILING PROFIT LOCK — a separate layer above the stop floor
          let hitTp = false;
          if (pActivated && !hitSl) {
            const trail = trailingStopPrice(p.entryPrice, ppeak);
            if (mark <= trail) {
              const n = (paperTrailBreach.current.get(p.id) ?? 0) + 1;
              paperTrailBreach.current.set(p.id, n);
              hitTp = n >= 2;
            } else {
              paperTrailBreach.current.delete(p.id);
            }
          } else {
            paperTrailBreach.current.delete(p.id);
          }
          if (!hitTp && !hitSl && !hitTime) {
            paperCapitTicks.current.delete(p.id);
            continue;
          }
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
          // stop-limit band (mirrors LIVE): never dump through a gapped stop;
          // exit below the band only after ~3 healthy-book confirmations
          if (reason !== "TAKE_PROFIT") {
            const slFloor = Math.max(0.01, p.slPrice - Math.max(0.04, p.slPrice * 0.12));
            if (exitPrice < slFloor) {
              const healthy = pSpread !== null && pSpread <= Math.max(0.04, mark * 0.15);
              const ticks = healthy ? (paperCapitTicks.current.get(p.id) ?? 0) + 1 : (paperCapitTicks.current.get(p.id) ?? 0);
              paperCapitTicks.current.set(p.id, ticks);
              if (ticks < 3) continue;
            } else {
              paperCapitTicks.current.delete(p.id);
            }
          }
          slBreach.current.delete(p.id);
          paperCapitTicks.current.delete(p.id);
          paperTrailBreach.current.delete(p.id);
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
    if (config.executionMode === "LIVE" && desk.liveBaseline !== null && liveCash !== null) {
      // cost-basis equity delta: cash + open-position cost vs the same sum at
      // engage. Entries move cash into cost basis (P&L unchanged); each close
      // moves realized P&L only. Raw cash delta would read every deployment
      // as a loss and every returning principal as profit. liveCash (pending-
      // spend-corrected) keeps a just-filled entry from inflating P&L for the
      // ~10s until the balance poll catches up. Only the CURRENT identity's
      // positions count — mixing the other account's cost basis into this
      // wallet's cash delta would corrupt target/brake/ladder math.
      const openCost = desk.liveExecuted.filter(ownedByLive).reduce((s, e) => s + e.costUsd, 0);
      const pnl = liveCash + openCost - desk.liveBaseline;
      if (pnl >= config.targetProfitUsd) {
        desk.setHalt(`TARGET REACHED — +$${pnl.toFixed(2)} LIVE (WALLET-MEASURED) · DESK STANDBY`);
        notify({ kind: "SYSTEM", title: "AI DESK — LIVE TARGET REACHED", body: `Wallet is up $${pnl.toFixed(2)} since engage.`, href: "/ai" });
        sendLiveMail({ kind: "TARGET", key: `target:${desk.liveBaseline}`, title: "TARGET REACHED", detail: `Wallet up $${pnl.toFixed(2)} since engage — desk standing down.`, kpi: liveMailKpi() });
      } else if (pnl <= -effCfg.maxLossUsd) {
        desk.setHalt(`LOSS BRAKE — $${pnl.toFixed(2)} LIVE (LIMIT $${effCfg.maxLossUsd}) · DESK STANDBY`);
        sendLiveMail({ kind: "LOSS_BRAKE", key: `brake:${desk.liveBaseline}`, title: "LOSS BRAKE", detail: `Session P&L $${pnl.toFixed(2)} hit the -$${effCfg.maxLossUsd} brake — desk standing down. Open positions remain exit-managed.`, kpi: liveMailKpi() });
      } else {
        // profit-lock ladder: crossing 25/50/75% of target banks half the rung.
        // e.g. target $500 → at +$250 lock $125 (play on with $125, $125 safe).
        // P&L here is wallet-cash delta, so a rung only triggers on money that
        // actually came back to the wallet — never on paper marks. The floor
        // itself is enforced by the ARM entry gate (cash can never be spent
        // below baseline+locked) and exits only ever ADD cash, so no separate
        // halt is needed: the banked amount is mathematically unreachable.
        for (const f of [0.75, 0.5, 0.25]) {
          const rung = config.targetProfitUsd * f;
          const lockTo = Math.round((rung / 2) * 100) / 100;
          if (pnl >= rung && desk.lockedProfitUsd < lockTo) {
            desk.setLockedProfit(lockTo);
            notify({ kind: "SYSTEM", title: "AI DESK — PROFIT LOCKED", body: `+$${pnl.toFixed(2)} reached ${Math.round(f * 100)}% of target — $${lockTo.toFixed(2)} banked, playing on with the rest.`, href: "/ai" });
            sendLiveMail({ kind: "LOCK", key: `lock:${desk.liveBaseline}:${f}`, title: `PROFIT LOCKED — $${lockTo.toFixed(2)} BANKED`, detail: `Session P&L +$${pnl.toFixed(2)} crossed ${Math.round(f * 100)}% of the $${config.targetProfitUsd} target. $${lockTo.toFixed(2)} is now untouchable; the desk plays on with cash above the floor only.`, kpi: liveMailKpi() });
            break;
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, paper, quotes, config, liveUsdc]);

  // identity flip (ARM/DISARM) mid-session: the baseline/ladder were anchored
  // to the OTHER wallet's cash — measuring session-proxy cash against a
  // Phantom-era baseline fires fictitious LOSS BRAKE / TARGET halts and banks
  // phantom profit locks. A signer change always stands the desk down and
  // resets the anchors; the operator re-engages under the new identity.
  const prevIdentity = useRef<string | null>(null);
  useEffect(() => {
    const id = liveAddress?.toLowerCase() ?? null;
    if (prevIdentity.current !== null && prevIdentity.current !== id && config.executionMode === "LIVE") {
      if (desk.liveBaseline !== null) desk.setLiveBaseline(null);
      if (desk.lockedProfitUsd !== 0) desk.setLockedProfit(0);
      if (engaged) {
        desk.setHalt("SIGNER CHANGED — RE-ENGAGE UNDER THE NEW TRADING IDENTITY");
        notify({ kind: "SYSTEM", title: "AI DESK — SIGNER CHANGED", body: "Trading identity switched; P&L anchors reset. Re-engage to continue.", href: "/ai" });
      }
    }
    prevIdentity.current = id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAddress, config.executionMode]);

  // LIVE baseline: wallet balance snapshot at engage; cleared on stand-down —
  // the target is measured against REAL money, deposits mid-session skew it.
  // The profit lock lives and dies with the baseline: a fresh engage gets a
  // fresh ladder (the previously banked cash is simply part of the new bank).
  useEffect(() => {
    if (engaged && config.executionMode === "LIVE" && liveCash !== null && desk.liveBaseline === null) {
      // anchor = cash + cost basis of already-open positions. Engaging (or
      // re-engaging after a reload) with positions deployed must not count
      // their returning principal as fresh profit — otherwise the ladder
      // banks capital as if it were gains and the target fires spuriously.
      const openCost = useAiDesk.getState().liveExecuted.filter(ownedByLive).reduce((s, e) => s + e.costUsd, 0);
      desk.setLiveBaseline(liveCash + openCost);
    }
    if (!engaged && desk.liveBaseline !== null) {
      desk.setLiveBaseline(null);
      if (desk.lockedProfitUsd !== 0) desk.setLockedProfit(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, config.executionMode, liveUsdc]);

  // ---- LIVE: ARM auto-staging (PHANTOM-manual path only) --------------------
  // When the autopilot session signer is armed, the FAST direct-fill effect
  // below owns entries (PAPER-speed, multi-fill, no ticket). This slow
  // one-at-a-time ticket path only runs for the Phantom-signed manual case,
  // where each order legitimately needs its own wallet prompt.
  useEffect(() => {
    if (autoOn) return; // fast path owns entries when armed
    if (!engaged || config.executionMode !== "LIVE" || config.mode !== "ARM" || ticketOpen) return;
    if (desk.liveExecuted.filter(ownedByLive).length >= config.maxPositions) return;
    const next = decisions
      .filter((d) => d.status === "PROPOSED" && d.eligible && d.evCents > 0 && d.aiVerdict !== "VETO" && (!config.claudeEnabled || d.aiVerdict === "GO"))
      // hard cash floor: an entry may only spend cash the desk has actually
      // SEEN (pending-spend-corrected), and with a profit lock active only
      // cash ABOVE baseline+locked. Unknown balance fails CLOSED — with the
      // session signer there is no human prompt left to catch a blind order,
      // and staging from budgetUsd against a $0 proxy just bounce-loops.
      .filter((d) => {
        if (liveCash === null) return false;
        return d.sizeUsd <= (liveCashFloor !== null ? liveCash - liveCashFloor : liveCash);
      })
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
  }, [engaged, config, ticketOpen, decisions, universe, autoOn]);

  // ---- LIVE: FAST autopilot entries (session-signed, PAPER-speed) -----------
  // Mirrors the PAPER opener exactly — multi-fill per sweep against the real
  // book, depth-clipped, walk-guarded — but places REAL BUY orders signed
  // silently by the session key. No ticket, no per-order prompt, no 1.2s
  // stage delay. Only runs when the autopilot signer is armed.
  const liveOpening = useRef(false);
  useEffect(() => {
    // every early return states WHY here instead of failing silently — the
    // operator reads this instead of opening devtools to find out why the
    // desk looks idle despite EV-positive candidates in the decision feed
    const status = (s: string | null) => desk.setLiveAutoStatus(s);
    if (config.executionMode !== "LIVE") return;
    if (proxyOwnedByOther) {
      status("AUTOPILOT MISCONFIGURED — LINKED PROXY BELONGS TO A DIFFERENT WALLET. CLEAR IT IN THE AUTOPILOT SIGNER PANEL AND RELINK.");
      return;
    }
    if (!autoOn) {
      status("AUTOPILOT NOT ARMED — ENTRIES WAIT FOR A MANUAL WALLET PROMPT");
      return;
    }
    if (!engaged) {
      status("DESK STANDING DOWN — ENGAGE TO RESUME AUTOPILOT ENTRIES");
      return;
    }
    if (config.mode !== "ARM") {
      status("STAGING MODE IS ADVISE — SWITCH TO ARM FOR AUTOPILOT TO ENTER AUTOMATICALLY");
      return;
    }
    if (liveOpening.current || liveClosing.current) return; // mid-cycle, leave prior status showing
    const wClient = sessionWalletClient();
    const wAddr = sessionAddress();
    if (!wClient || !wAddr || liveCash === null) {
      status("WALLET BALANCE UNKNOWN — RETRYING (RPC OR SESSION SIGNER NOT READY)");
      return;
    }
    const owned = desk.liveExecuted.filter(ownedByLive);
    const slots = effCfg.maxPositions - owned.length;
    if (slots <= 0) {
      status(`MAX POSITIONS REACHED (${owned.length}/${effCfg.maxPositions}) — WAITING FOR AN EXIT TO FREE A SLOT`);
      return;
    }
    // spendable = cash above the profit-lock floor; the ladder caps how much
    // of the bank may be in the market at once (expands as profit accrues)
    const spendableCash = liveCashFloor !== null ? liveCash - liveCashFloor : liveCash;
    if (spendableCash < effCfg.minTradeUsd) {
      status(
        liveCashFloor !== null
          ? `CASH BELOW THE MIN CLIP AFTER THE PROFIT-LOCK FLOOR (SPENDABLE $${spendableCash.toFixed(2)} < $${effCfg.minTradeUsd.toFixed(2)})`
          : `CASH BELOW MIN CLIP ($${spendableCash.toFixed(2)} < $${effCfg.minTradeUsd.toFixed(2)}) — FUND THE TRADING WALLET`,
      );
      return;
    }
    const baseline = desk.liveBaseline ?? liveCash;
    // ownerless legacy trades belong to Phantom (mirror ownerOf), NOT the
    // session identity — attributing them to a burner would skew its ladder
    const realizedOwned = desk.liveClosed
      .filter((t) => (t.owner ?? phantomAddress?.toLowerCase()) === wAddr.toLowerCase())
      .reduce((s, t) => s + t.pnl, 0);
    const capFrac = deployCapFrac(realizedOwned, Math.max(baseline, 1));
    const deployedCost = owned.reduce((s, e) => s + e.costUsd, 0);
    const ladderUsd = Math.max(capFrac * baseline, Math.min(2 * effCfg.minTradeUsd, 0.5 * baseline));
    let headroom = Math.min(ladderUsd - deployedCost, spendableCash);
    if (headroom < effCfg.minTradeUsd) {
      status(`DEPLOYMENT LADDER FULL THIS CYCLE ($${deployedCost.toFixed(2)} of $${ladderUsd.toFixed(2)} ladder deployed) — EXPANDS AS PROFIT ACCRUES`);
      return;
    }
    const perCycle = realizedOwned < -0.02 * baseline ? Math.max(1, Math.floor(tempo.entriesPerCycle / 2)) : tempo.entriesPerCycle;
    const openSlugs = new Set(owned.map((e) => e.slug));
    const candidates = decisions.filter((d) => d.status === "PROPOSED");
    const batch = candidates
      .filter((d) => d.eligible && d.evCents > 0 && d.aiVerdict !== "VETO" && (!config.claudeEnabled || d.aiVerdict === "GO"))
      .filter((d) => !openSlugs.has(d.slug)) // never double-enter the same market
      // copies first (a tracked elite operator's live conviction), then EV/hr
      .sort((x, y) => (x.copy ? 0 : 1) - (y.copy ? 0 : 1) || y.evPerHourUsd - x.evPerHourUsd)
      .slice(0, Math.min(perCycle, slots));
    if (!batch.length) {
      status(
        !candidates.length
          ? "NO PROPOSED DECISIONS THIS SWEEP — WAITING FOR THE NEXT CYCLE"
          : `${candidates.length} PROPOSED, 0 CLEARED THE ELIGIBILITY FILTER (REAL-SIGNAL BACKING + EV>0 + NOT ALREADY HELD) THIS CYCLE`,
      );
      return;
    }
    status(null); // clear — about to act

    liveOpening.current = true;
    (async () => {
      try {
        let cashLeft = headroom;
        let filledCount = 0;
        let lastSkipReason: string | null = null;
        for (const next of batch) {
          if (cashLeft < effCfg.minTradeUsd) break;
          const market = universe?.find((m) => m.slug === next.slug);
          if (!market) continue;
          try {
            const book = await fetchOrderBook(next.tokenId);
            const stats = bookStats(book);
            // depth-aware sizing: only dollars fillable within 1% of best ask,
            // and never more than half of that tight depth (thin-book markout)
            let tightDepth = 0;
            if (stats.bestAsk !== null) {
              for (const lvl of stats.asks) {
                if (lvl.price > stats.bestAsk * 1.01) break;
                tightDepth += lvl.price * lvl.size;
              }
            }
            const spend = Math.min(next.sizeUsd, cashLeft, headroom, tightDepth * 0.5);
            if (spend < effCfg.minTradeUsd) {
              useAiDesk.getState().setDecisionStatus(next.id, "SKIPPED");
              lastSkipReason = `${next.question.slice(0, 40)} — book too thin within 1% of ask for a viable clip`;
              continue;
            }
            const fill = estimateFill(stats.asks, spend);
            const askRef = stats.bestAsk ?? fill.avgPrice;
            // walk guard: never pay >1% above the QUOTED best ask
            if (fill.shares <= 0 || fill.avgPrice <= 0 || fill.avgPrice > askRef * 1.01) {
              useAiDesk.getState().setDecisionStatus(next.id, "SKIPPED");
              lastSkipReason = `${next.question.slice(0, 40)} — fill would walk >1% past the quoted ask`;
              continue;
            }
            const tick = market.tickSize;
            const limit = snapToTick(Math.min(1 - tick, fill.avgPrice * 1.02 + tick), tick);
            const shares = Math.floor((spend / limit) * 100) / 100;
            if (shares < 0.01) {
              useAiDesk.getState().setDecisionStatus(next.id, "SKIPPED");
              lastSkipReason = `${next.question.slice(0, 40)} — clip rounds to under 0.01 shares`;
              continue;
            }
            // small clips fill all-or-nothing (FOK): a partial fill on a $2-4
            // clip can land under the CLOB's $1 minimum — an instant dust
            // position no order can ever exit (rides to resolution). Larger
            // clips keep FAK; a big partial is still a viable position.
            const entryType = spend <= 10 ? "FOK" : "FAK";
            const res = await signAndPlaceOrder(wClient, wAddr, {
              tokenId: next.tokenId,
              side: "BUY",
              price: limit,
              shares,
              tickSize: tick,
              negRisk: market.negRisk,
              orderType: entryType,
            });
            if (!res.success) {
              // a config-fault (auth/maker/version) can't be fixed by retrying —
              // disarm and surface it once, exactly like the manual ARM guard
              if (res.errorMsg && /does not match auth|requires a Relayer|Builder API Key|maker address not allowed|invalid order version/i.test(res.errorMsg)) {
                useSessionSigner.getState().setEnabled(false);
                notify({ kind: "SYSTEM", title: "AUTOPILOT PAUSED — CONFIG FAULT", body: res.errorMsg.slice(0, 140), href: "/ai" });
                sendLiveMail({ kind: "FAULT", key: `autofault:${res.errorMsg.slice(0, 50)}`, title: "AUTOPILOT PAUSED — CONFIG FAULT", detail: `Session-signed entry failed unrecoverably: ${res.errorMsg.slice(0, 160)}` });
                status(`AUTOPILOT DISARMED — CONFIG FAULT: ${res.errorMsg.slice(0, 100)}`);
                break;
              }
              lastSkipReason = `${next.question.slice(0, 40)} — order rejected: ${(res.errorMsg ?? "no match").slice(0, 60)}`;
              continue; // transient (no match / thin book) — next candidate
            }
            // confirmed-fill accounting. A BUY response is the MIRROR of a
            // SELL: makingAmount = USDC SPENT, takingAmount = SHARES received
            // (verified against @polymarket/client order construction). Reading
            // it in the SELL frame would halve shares and near-zero the cost —
            // defeating the profit-lock floor and orphaning real shares.
            let filled = Number(res.takingAmount); // shares received
            if (Number.isFinite(filled) && filled > shares * 1.05) filled = filled / 1e6;
            if (!Number.isFinite(filled) || filled <= 0) {
              if (res.status !== "matched") continue; // unconfirmed — no phantom fill
              filled = shares;
            }
            filled = Math.min(filled, shares);
            let costUsd = Number(res.makingAmount); // USDC spent
            if (Number.isFinite(costUsd) && costUsd > filled * 1.05) costUsd = costUsd / 1e6;
            if (!Number.isFinite(costUsd) || costUsd <= 0 || costUsd > filled * 1.05) costUsd = filled * limit;
            const entryPx = costUsd / Math.max(filled, 0.01);
            const entryMid =
              stats.bestBid !== null && stats.bestAsk !== null ? (stats.bestBid + stats.bestAsk) / 2 : entryPx;
            const feeQuote = quote("SIGNAL", costUsd);
            desk.recordLiveExecution({
              decisionId: next.id,
              ts: Math.floor(Date.now() / 1000),
              slug: next.slug,
              question: next.question,
              tokenId: next.tokenId,
              outcome: next.outcome,
              entryPrice: entryPx,
              usd: costUsd,
              shares: filled,
              tickSize: tick,
              negRisk: market.negRisk,
              costUsd,
              feeUsd: feeQuote.feeUsd,
              tpPrice: Math.min(0.99, entryMid * (1 + next.tpFrac)),
              slPrice: Math.max(0.01, entryMid * (1 - next.slFrac)),
              deadline: Math.floor(Date.now() / 1000) + effCfg.maxHoldMin * 60,
              owner: wAddr.toLowerCase(),
            });
            logOrder({
              market: next.question,
              slug: next.slug,
              side: "BUY",
              outcome: next.outcome,
              price: entryPx,
              shares: filled,
              usd: costUsd,
              orderType: entryType,
              clobOrderId: res.orderID ?? null,
              txHash: res.transactionsHashes?.[0] ?? null,
              status: res.status ?? "matched",
              error: null,
              signer: wAddr.toLowerCase(),
            });
            accrue(feeQuote, { market: next.question, notionalUsd: costUsd });
            cashLeft -= costUsd + feeQuote.feeUsd;
            headroom -= costUsd;
            filledCount += 1;
            notify({
              kind: "ORDER",
              title: "AI DESK — LIVE FILL",
              body: `BUY ${next.outcome} · ${next.question.slice(0, 52)} — ${filled.toFixed(0)} sh @ ${(entryPx * 100).toFixed(1)}¢`,
              href: "/ai",
            });
            sendLiveMail({
              kind: "ENTRY",
              key: `entry:${next.id}`,
              title: `LIVE ENTRY — BUY ${next.outcome.toUpperCase()} @ ${(entryPx * 100).toFixed(1)}¢`,
              detail: `$${costUsd.toFixed(2)} filled · TP ${(Math.min(0.99, entryMid * (1 + next.tpFrac)) * 100).toFixed(1)}¢ / SL ${(Math.max(0.01, entryMid * (1 - next.slFrac)) * 100).toFixed(1)}¢ · P(win) ${(next.pWin * 100).toFixed(0)}% · EV +${next.evCents.toFixed(2)}¢/sh`,
              market: next.question,
              outcome: next.outcome,
              entryPrice: entryPx,
              sizeUsd: costUsd,
              reasons: next.reasons.slice(0, 4),
              kpi: liveMailKpi(),
            });
          } catch (e) {
            lastSkipReason = `${next.question.slice(0, 40)} — ${e instanceof Error ? e.message.slice(0, 60) : "book/order fault"}`;
            /* book/order fault — next candidate */
          }
        }
        if (filledCount > 0) {
          status(`FILLED ${filledCount} ENTR${filledCount === 1 ? "Y" : "IES"} THIS PASS`);
        } else if (lastSkipReason) {
          status(`ALL ${batch.length} CANDIDATE${batch.length === 1 ? "" : "S"} SKIPPED — ${lastSkipReason}`);
        }
      } finally {
        liveOpening.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, engaged, config, decisions, universe, liveCash]);

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
        const market = universe?.find((m) => m.slug === d.slug);
        const entryMid = match.price;
        const feeQuote = quote("SIGNAL", match.usd);
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
          tickSize: market?.tickSize ?? 0.01,
          negRisk: market?.negRisk ?? false,
          costUsd: match.usd,
          feeUsd: feeQuote.feeUsd,
          tpPrice: Math.min(0.99, entryMid * (1 + d.tpFrac)),
          slPrice: Math.max(0.01, entryMid * (1 - d.slFrac)),
          deadline: Math.floor(Date.now() / 1000) + effCfg.maxHoldMin * 60,
          // fire-time signer beats the currently-active identity — the user
          // may have toggled ARM between the fill and this match tick
          owner: match.signer ?? liveAddress?.toLowerCase(),
        });
        accrue(feeQuote, { market: d.question, notionalUsd: match.usd });
        sendLiveMail({
          kind: "ENTRY",
          key: `entry:${d.id}`,
          title: `LIVE ENTRY — BUY ${d.outcome.toUpperCase()} @ ${(match.price * 100).toFixed(1)}¢`,
          detail: `$${match.usd.toFixed(2)} filled · TP ${(Math.min(0.99, entryMid * (1 + d.tpFrac)) * 100).toFixed(1)}¢ / SL ${(Math.max(0.01, entryMid * (1 - d.slFrac)) * 100).toFixed(1)}¢ · P(win) ${(d.pWin * 100).toFixed(0)}% · EV +${d.evCents.toFixed(2)}¢/sh`,
          market: d.question,
          outcome: d.outcome,
          entryPrice: match.price,
          sizeUsd: match.usd,
          reasons: d.reasons.slice(0, 4),
          kpi: liveMailKpi(),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, decisions]);

  // ---- LIVE: exit management (TP / SL / time) — real SELL orders through the
  // official v2 client. Runs while any live position is open, independent of
  // `engaged`, so a stood-down desk never leaves a real position unmanaged.
  // Mirrors the PAPER exit tick's safeguards exactly: marks come from the
  // live book (not a stale WS quote), SL needs 2 consecutive breaching ticks,
  // and a "take profit" is verified against the actual bid-side sell before
  // it's allowed to close — a mid that ran ahead of exit liquidity holds.
  const { data: phantomWalletClient } = useWalletClient();
  // exits sign PER POSITION with the identity that OPENED it — the session
  // proxy holds no shares of Phantom-opened positions and vice versa. Session
  // positions stay managed even while DISARMED, as long as the key exists.
  const sessReady = !!sess.pk && !!sess.proxyWallet;
  const liveClosing = useRef(false);
  const liveSlBreach = useRef(new Map<string, number>());
  const liveUnmanagedWarned = useRef(new Set<string>()); // one warning per stuck position
  const liveUnmanagedMiss = useRef(new Map<string, number>()); // posId → consecutive no-signer ticks
  const liveDustWarned = useRef(new Set<string>()); // one note per sub-$1 unsellable remainder
  const liveTrailBreach = useRef(new Map<string, number>()); // posId → consecutive trailing-stop breach ticks
  const liveReconcileMiss = useRef(new Map<string, number>()); // posId → consecutive on-chain-shortfall ticks
  const liveGapHeld = useRef(new Set<string>()); // one note per position held through a dislocated/gapped book
  const liveCapitTicks = useRef(new Map<string, number>()); // posId → consecutive healthy-book ticks below the SL floor
  const liveResolveCheck = useRef(new Map<string, number>()); // posId → last resolution-check unix sec (throttle gamma)
  useEffect(() => {
    if (config.executionMode !== "LIVE" || !desk.liveExecuted.length) return;
    if (!phantomWalletClient && !sessReady) return; // no signer available at all
    const tick = async () => {
      if (liveClosing.current) return;
      liveClosing.current = true;
      try {
        const now = Math.floor(Date.now() / 1000);
        const open = useAiDesk.getState().liveExecuted;
        for (const p of open) {
          try {
            const book = await fetchOrderBook(p.tokenId);
            const stats = bookStats(book);
            const mark =
              stats.bestBid !== null && stats.bestAsk !== null ? (stats.bestBid + stats.bestAsk) / 2 : p.entryPrice;
            // migrated (pre-upgrade) position: rebase risk params off the
            // FIRST real mark, then persist. SL anchors below where the
            // position actually trades today — never below its long-gone
            // entry, which would fire-sale aged drawdowns on sight. Deadlines
            // stagger 30min apart so the book can never mass-dump at once.
            if (p.migrated && !p.rebasedTs) {
              if (stats.bestBid === null || stats.bestAsk === null) continue; // need a real book to rebase
              const T = TEMPO_PARAMS[useAiDesk.getState().config.tempo];
              desk.rebaseLivePosition(p.decisionId, {
                slPrice: Math.max(0.01, mark * (1 - T.slPct / 100)),
                tpPrice: Math.min(0.99, Math.max(p.tpPrice, mark * (1 + T.tpPct / 100))),
                deadline: now + 24 * 3600 + open.indexOf(p) * 1800,
                rebasedTs: now,
              });
              continue; // triggers evaluate from the next tick, on rebased values
            }
            // DISLOCATED-BOOK GUARD: when the bid side gets pulled, the mid
            // collapses artificially (bid 15¢ / ask 55¢ → mid 35¢) — that is
            // a liquidity hole, not a repricing. Trusting it would both
            // trigger phantom stop-losses AND sell into garbage bids. A
            // dislocated book freezes this position for the tick: no breach
            // counting, no exits, until two-sided quotes return.
            const spread = stats.bestBid !== null && stats.bestAsk !== null ? stats.bestAsk - stats.bestBid : null;
            if (spread !== null && spread > Math.max(0.1, mark * 0.4)) {
              if (!liveGapHeld.current.has(p.decisionId)) {
                liveGapHeld.current.add(p.decisionId);
                notify({ kind: "SYSTEM", title: "BOOK DISLOCATED — POSITION FROZEN", body: `${p.question.slice(0, 56)} — bids pulled (spread ${(spread * 100).toFixed(0)}¢). No exit will fire into this; waiting for two-sided quotes.`, href: "/ai" });
              }
              continue;
            }
            // LET WINNERS RUN: the old fixed take-profit is now only an
            // ACTIVATION level. Once the peak clears it, the position is no
            // longer capped — a ratcheting trailing stop (trailingStopPrice)
            // protects the gain while the winner rides toward resolution. A
            // fixed stop-loss guards the downside until activation; after
            // activation the trailing stop sits above breakeven so a winner
            // can never become a loss, and the time deadline no longer applies
            // (a running winner is never time-stopped).
            const peak = Math.max(p.peakMark ?? p.entryPrice, mark);
            if (peak > (p.peakMark ?? p.entryPrice) + 1e-6) {
              desk.rebaseLivePosition(p.decisionId, { peakMark: peak });
            }
            const activated = peak >= p.tpPrice;
            const hitTime = !activated && now >= p.deadline;
            // HARD STOP FLOOR — always armed, even after activation. A winner
            // that reverses all the way through its fixed stop is still a
            // stop-loss; the stop-limit band + capitulation below govern the
            // actual sell (gap-safe). Without this, an activated position that
            // collapsed had NO loss-side exit and rode to zero.
            let hitSl = false;
            if (mark <= p.slPrice) {
              const n = (liveSlBreach.current.get(p.decisionId) ?? 0) + 1;
              liveSlBreach.current.set(p.decisionId, n);
              hitSl = n >= 2;
            } else {
              liveSlBreach.current.delete(p.decisionId);
            }
            // TRAILING PROFIT LOCK — a separate layer sitting ABOVE the stop
            // floor, active only once the position has run past activation.
            // Locks a gain when it pulls back to the trail; the net-positive
            // check below holds it if a gap would make the sell a loss (the
            // hard SL then catches a deeper collapse).
            let hitTp = false;
            if (activated && !hitSl) {
              const trail = trailingStopPrice(p.entryPrice, peak);
              if (mark <= trail) {
                const n = (liveTrailBreach.current.get(p.decisionId) ?? 0) + 1;
                liveTrailBreach.current.set(p.decisionId, n);
                hitTp = n >= 2;
              } else {
                liveTrailBreach.current.delete(p.decisionId);
              }
            } else {
              liveTrailBreach.current.delete(p.decisionId);
            }
            if (!hitTp && !hitSl && !hitTime) {
              liveCapitTicks.current.delete(p.decisionId);
              liveGapHeld.current.delete(p.decisionId);
              continue;
            }
            // verified-real profit exit: only lock the trailing stop if selling
            // into the ACTUAL bids nets a profit; a gap below the trail HOLDS
            // (the position recovers, or a real collapse trips the fixed SL /
            // stop-limit band on a later tick)
            if (hitTp && !hitSl && !hitTime) {
              const preview = estimateSell(stats.bids, p.shares);
              const previewProceeds = preview.filledShares > 0 ? preview.proceedsUsd : mark * p.shares;
              const previewFee = quote("SIGNAL", previewProceeds).feeUsd;
              if (previewProceeds - previewFee - p.costUsd - p.feeUsd <= 0) continue;
            }
            // the SELL must come from the account whose proxy holds the
            // shares — resolve the signer from the position's owner
            const owner = ownerOf(p);
            const sessAddr = sessionAddress();
            const useSession = sessReady && !!sessAddr && owner === sessAddr.toLowerCase();
            const wClient = useSession ? sessionWalletClient() : phantomWalletClient;
            const wAddr = useSession ? sessAddr : phantomAddress;
            if (!wClient || !wAddr || (owner !== null && wAddr.toLowerCase() !== owner)) {
              // owning wallet unavailable — hold, but NEVER silently: an
              // exit trigger with no signer means TP/SL protection is dead
              // for this position until that wallet comes back. Requires 2
              // CONSECUTIVE ticks before warning (~10s) — a page-just-loaded
              // wagmi connector takes a tick or two to hydrate, and warning
              // on that transient blip is a false alarm every single reload.
              const misses = (liveUnmanagedMiss.current.get(p.decisionId) ?? 0) + 1;
              liveUnmanagedMiss.current.set(p.decisionId, misses);
              if (misses >= 2 && !liveUnmanagedWarned.current.has(p.decisionId)) {
                liveUnmanagedWarned.current.add(p.decisionId);
                notify({
                  kind: "SYSTEM",
                  title: "LIVE EXIT BLOCKED — OWNER WALLET UNAVAILABLE",
                  body: `${p.question.slice(0, 56)} hit an exit trigger but its owning wallet (${owner?.slice(0, 10) ?? "unknown"}…) is not available to sign. Reconnect it — TP/SL cannot fire until then.`,
                  href: "/ai",
                });
                sendLiveMail({
                  kind: "FAULT",
                  key: `unmanaged:${p.decisionId}`,
                  title: "EXIT BLOCKED — OWNER WALLET UNAVAILABLE",
                  detail: `An exit trigger fired but the owning wallet ${owner?.slice(0, 12) ?? "(unknown)"}… is unavailable to sign the SELL. The position is UNPROTECTED until that wallet reconnects.`,
                  market: p.question,
                  outcome: p.outcome,
                  kpi: liveMailKpi(),
                });
              }
              continue;
            }
            liveUnmanagedMiss.current.delete(p.decisionId);
            liveUnmanagedWarned.current.delete(p.decisionId);
            // ground-truth reconciliation: p.shares is a LEDGER value, and a
            // legacy recording bug (fixed alongside this) logged the
            // pre-trade REQUESTED size instead of the confirmed fill —
            // stale positions can still carry a stale, overstated count. A
            // SELL sized off that overstated ledger requests more than the
            // wallet actually holds and bounces "not enough balance" every
            // tick forever (observed live). Check the real on-chain balance
            // before every exit attempt and correct the ledger to match.
            //
            // Three safety layers on top of the raw read (adversarial review
            // caught all three as real risks to a real position):
            // 1. skip entirely for a position younger than 15s — a just-filled
            //    BUY's ERC-1155 transfer may not be mined yet; reading 0 here
            //    would be a false negative on real, freshly-owned shares.
            // 2. require 2 CONSECUTIVE ticks agreeing on a shortfall before
            //    acting (mirrors the SL-breach confirmation below) — a single
            //    stale/lagging RPC read must never delete real money.
            // 3. the balance is the wallet's TOTAL holding of this tokenId,
            //    pooled across every LiveExecution entry that shares it —
            //    subtract what siblings already claim before judging p short,
            //    so selling one entry can never falsely zero out another.
            const now2 = Math.floor(Date.now() / 1000);
            if (now2 - p.ts < 15) {
              liveReconcileMiss.current.delete(p.decisionId);
            } else {
              const makerWallet = cachedDepositWallet(wAddr);
              let onChainShares: number | null = null;
              if (makerWallet) {
                try {
                  onChainShares = await readCtfShareBalance(makerWallet, p.tokenId);
                } catch {
                  /* RPC hiccup — proceed on the ledgered value this tick */
                }
              }
              if (onChainShares !== null) {
                const siblingShares = open
                  .filter((e) => e.decisionId !== p.decisionId && e.tokenId === p.tokenId && ownerOf(e) === owner)
                  .reduce((s, e) => s + e.shares, 0);
                const allocatable = Math.max(0, onChainShares - siblingShares);
                if (allocatable < p.shares - 0.01) {
                  const misses = (liveReconcileMiss.current.get(p.decisionId) ?? 0) + 1;
                  liveReconcileMiss.current.set(p.decisionId, misses);
                  if (misses >= 2) {
                    liveReconcileMiss.current.delete(p.decisionId);
                    if (allocatable < 0.01) {
                      // nothing left to sell on-chain — write off without
                      // fabricating a P&L (we don't know what actually
                      // happened: stale estimate, redemption, fill
                      // elsewhere). Stops the endless bounce loop honestly.
                      desk.writeOffLivePosition(p.decisionId);
                      notify({ kind: "SYSTEM", title: "POSITION RECONCILED — NO SHARES ON-CHAIN", body: `${p.question.slice(0, 56)} showed 0 on-chain balance (twice confirmed) for ${p.shares.toFixed(2)} ledgered shares — removed. Check Polymarket's own history if you need the real outcome.`, href: "/ai" });
                      sendLiveMail({ kind: "FAULT", key: `reconcile-zero:${p.decisionId}`, title: "POSITION RECONCILED — 0 ON-CHAIN", detail: `Ledger showed ${p.shares.toFixed(2)} shares but the wallet holds 0 on-chain (twice confirmed). Removed from tracking; no P&L booked (unknown true outcome).`, market: p.question, outcome: p.outcome, kpi: liveMailKpi() });
                    } else {
                      const factor = allocatable / p.shares;
                      desk.rebaseLivePosition(p.decisionId, {
                        shares: allocatable,
                        costUsd: p.costUsd * factor,
                        feeUsd: p.feeUsd * factor,
                        usd: p.usd * factor,
                      });
                      notify({ kind: "SYSTEM", title: "POSITION SIZE RECONCILED", body: `${p.question.slice(0, 56)} — ledger said ${p.shares.toFixed(2)} sh, wallet allocates ${allocatable.toFixed(2)} (twice confirmed). Corrected.`, href: "/ai" });
                    }
                  }
                  continue; // re-evaluate this position fresh next tick
                }
                liveReconcileMiss.current.delete(p.decisionId);
              }
            }
            // fresh universe row is ground truth for order params — the stored
            // values may be migration defaults on pre-upgrade positions
            const mkt = universe?.find((m) => m.slug === p.slug);
            const tickSize = mkt?.tickSize ?? p.tickSize;
            const negRisk = mkt?.negRisk ?? p.negRisk;
            // RESOLUTION CHECK: a market with no bids (or a sub-$1 dust
            // remainder) may have RESOLVED — shares are then worth $1 (win) or
            // $0 (loss), collected by redeeming on Polymarket, and there is
            // nothing to sell. Detecting it books the settled P&L (the +$5.04
            // the operator redeemed manually was invisible to the ledger) and
            // stops the position hanging in OPEN forever. Throttled to one
            // gamma lookup / 45s per position (only illiquid positions reach
            // here, and resolution is a one-way state).
            const illiquid = stats.bestBid === null;
            const dust = !illiquid && (() => {
              const bf = Math.max(tickSize, (stats.bestBid ?? 0) * 0.9);
              const pv = estimateSell(stats.bids.filter((b) => b.price >= bf), p.shares);
              return Math.floor(pv.filledShares * 100) / 100 * pv.avgPrice < 1.02;
            })();
            if (illiquid || dust) {
              const last = liveResolveCheck.current.get(p.decisionId) ?? 0;
              if (now - last >= 45) {
                liveResolveCheck.current.set(p.decisionId, now);
                // always re-fetch (a cached universe row can still show the
                // market open); gamma is the ground truth for resolution
                const live = await fetchMarketBySlug(p.slug).catch(() => null);
                const oi = live ? live.outcomes.findIndex((o) => o.toLowerCase() === p.outcome.toLowerCase()) : -1;
                const resolvedPx = live && oi >= 0 ? (live.outcomePrices[oi] ?? 0.5) : 0.5;
                // require a DECISIVE settlement: closed AND the outcome priced
                // to ~1 or ~0. A closed-but-still-ambiguous market (prices near
                // 0.5) re-checks next cycle rather than mis-booking a coin flip.
                if (live?.closed && (resolvedPx >= 0.95 || resolvedPx <= 0.05)) {
                  const won = resolvedPx >= 0.95;
                  const pnl = (won ? p.shares : 0) - p.costUsd - p.feeUsd;
                  desk.recordLiveResolution(p.decisionId, won);
                  liveResolveCheck.current.delete(p.decisionId);
                  notify({
                    kind: "ORDER",
                    title: won ? "AI DESK — MARKET RESOLVED (WON)" : "AI DESK — MARKET RESOLVED (LOST)",
                    body: won
                      ? `${p.question.slice(0, 52)} — ${p.outcome.toUpperCase()} won. ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} net. Redeem on Polymarket to collect.`
                      : `${p.question.slice(0, 52)} — ${p.outcome.toUpperCase()} lost. $${pnl.toFixed(2)}.`,
                    href: "/ai",
                  });
                  sendLiveMail({
                    kind: won ? "CLOSE" : "FAULT",
                    key: `resolved:${p.decisionId}`,
                    title: won ? `RESOLVED WON — +$${pnl.toFixed(2)} NET (REDEEM TO COLLECT)` : `RESOLVED LOST — $${pnl.toFixed(2)}`,
                    detail: `${p.outcome.toUpperCase()} on "${p.question.slice(0, 60)}" settled ${won ? "IN YOUR FAVOR — each share redeems for $1" : "against you — shares are worth $0"}. ${won ? "Collect by redeeming on Polymarket (or it auto-credits)." : "No action needed."}`,
                    market: p.question,
                    outcome: p.outcome,
                    entryPrice: p.entryPrice,
                    exitPrice: won ? 1 : 0,
                    sizeUsd: p.costUsd,
                    pnlUsd: pnl,
                    reason: "RESOLVED",
                    kpi: liveMailKpi(),
                  });
                  continue;
                }
              }
            }
            // FAK sells must be priced off the ACTUAL bids, not the mid: on a
            // thin/wide book the mid sits far above the best bid, the bound
            // never matches, and the order dies "no orders found to match"
            // every tick forever (observed live). BUT only bids near the top
            // of the book count — estimateSell walks the whole stack, and a
            // garbage penny-bid wall would drag the average down and set its
            // own acceptance price (dumping the position for ~nothing).
            if (stats.bestBid === null) continue;
            const bidFloor = Math.max(tickSize, stats.bestBid * 0.9);
            const sellPreview = estimateSell(stats.bids.filter((b) => b.price >= bidFloor), p.shares);
            const sellShares = Math.floor(sellPreview.filledShares * 100) / 100;
            if (sellShares < 0.01) continue; // no real depth near the top — retry later
            // CLOB rejects sub-$1 notionals — dust can never be sold; hold it
            // for resolution instead of hammering doomed orders every tick
            if (sellShares * sellPreview.avgPrice < 1.02) {
              if (!liveDustWarned.current.has(p.decisionId)) {
                liveDustWarned.current.add(p.decisionId);
                notify({ kind: "SYSTEM", title: "REMAINDER BELOW CLOB $1 MINIMUM", body: `${p.question.slice(0, 56)} — ${sellShares.toFixed(2)} sh (~$${(sellShares * sellPreview.avgPrice).toFixed(2)}) cannot be sold; it rides to resolution.`, href: "/ai" });
              }
              continue;
            }
            liveDustWarned.current.delete(p.decisionId);
            // STOP-LIMIT BAND: a stop-loss is a max-pain line, not a market
            // dump. If the book only pays materially BELOW the stop (gapped
            // through it — entry 79¢, stop 75¢, best fill 15¢), selling
            // instantly donates the gap. Hold instead — UNLESS the market has
            // GENUINELY repriced: a tight, two-sided book below the floor for
            // 3 consecutive ticks (~15s) is a real move, and an orderly exit
            // there salvages what's left rather than riding to zero. Pure-TP
            // closes skip this (already net-positive-verified above).
            if (!(hitTp && !hitSl && !hitTime)) {
              const slFloor = Math.max(0.01, p.slPrice - Math.max(0.04, p.slPrice * 0.12));
              if (sellPreview.avgPrice < slFloor) {
                const healthy = spread !== null && spread <= Math.max(0.04, mark * 0.15);
                const ticks = healthy ? (liveCapitTicks.current.get(p.decisionId) ?? 0) + 1 : (liveCapitTicks.current.get(p.decisionId) ?? 0);
                liveCapitTicks.current.set(p.decisionId, ticks);
                if (ticks < 3) {
                  if (!liveGapHeld.current.has(p.decisionId)) {
                    liveGapHeld.current.add(p.decisionId);
                    notify({ kind: "SYSTEM", title: "STOP GAPPED — HOLDING, NOT DUMPING", body: `${p.question.slice(0, 56)} — book pays ~${(sellPreview.avgPrice * 100).toFixed(0)}¢ vs stop ${(p.slPrice * 100).toFixed(0)}¢. Holding; will exit only on a confirmed two-sided repricing.`, href: "/ai" });
                    sendLiveMail({ kind: "FAULT", key: `slgap:${p.decisionId}`, title: "STOP GAPPED — HOLDING", detail: `${p.outcome.toUpperCase()} stop at ${(p.slPrice * 100).toFixed(0)}¢ but the book only pays ~${(sellPreview.avgPrice * 100).toFixed(0)}¢. Not dumping into the gap; exiting only if a tight two-sided book confirms the repricing (~15s), else the position holds.`, market: p.question, outcome: p.outcome, kpi: liveMailKpi() });
                  }
                  continue;
                }
                // 3 healthy ticks below the floor — genuine repricing;
                // fall through to an orderly exit at the real book
              } else {
                liveCapitTicks.current.delete(p.decisionId);
              }
            }
            const bound = Math.max(tickSize, sellPreview.avgPrice * 0.985 - tickSize);
            const snapped = snapToTick(bound, tickSize);
            const res = await signAndPlaceOrder(wClient, wAddr, {
              tokenId: p.tokenId,
              side: "SELL",
              price: snapped,
              shares: sellShares,
              tickSize,
              negRisk,
              orderType: "FAK",
            });
            if (!res.success) continue; // retry next tick
            // response semantics for a SELL: makingAmount = shares we gave,
            // takingAmount = DOLLARS received. Only a CONFIRMED fill may be
            // ledgered — assuming a fill on an amountless/delayed response
            // fabricates proceeds and orphans real shares (safe direction for
            // a 5s retry loop is zero-fill).
            let filled = Number(res.makingAmount);
            if (Number.isFinite(filled) && filled > sellShares * 1.05) filled = filled / 1e6;
            if (!Number.isFinite(filled) || filled <= 0) {
              if (res.status !== "matched") continue; // unconfirmed — retry next tick
              filled = sellShares; // server says matched; amounts absent
            }
            filled = Math.min(filled, sellShares);
            let proceeds = Number(res.takingAmount);
            if (Number.isFinite(proceeds) && proceeds > filled * 1.05) proceeds = proceeds / 1e6;
            if (!Number.isFinite(proceeds) || proceeds <= 0 || proceeds > filled * 1.05) proceeds = filled * sellPreview.avgPrice;
            const exitPx = proceeds / Math.max(filled, 0.01); // honest average fill, not the mid
            const exitFeeQuote = quote("SIGNAL", proceeds);
            const reason = hitTp && !hitSl ? "TAKE_PROFIT" : hitSl ? "STOP_LOSS" : "TIME_EXIT";
            const fullClose = filled >= p.shares - 0.01;
            if (fullClose) {
              liveSlBreach.current.delete(p.decisionId);
              liveTrailBreach.current.delete(p.decisionId);
              liveCapitTicks.current.delete(p.decisionId);
              liveGapHeld.current.delete(p.decisionId);
              desk.recordLiveClose(p.decisionId, exitPx, proceeds, exitFeeQuote.feeUsd, reason);
            } else {
              // keep the SL breach streak: the remainder is still through its
              // stop — waiting 2 fresh ticks per slice prolongs a falling exit
              desk.recordLivePartialClose(p.decisionId, filled, exitPx, proceeds, exitFeeQuote.feeUsd, reason);
            }
            accrue(exitFeeQuote, { market: p.question, notionalUsd: proceeds });
            const frac = fullClose ? 1 : filled / p.shares;
            const pnl = proceeds - exitFeeQuote.feeUsd - p.costUsd * frac - p.feeUsd * frac;
            const partialTag = fullClose ? "" : ` (PARTIAL ${filled.toFixed(2)}/${p.shares.toFixed(2)} SH)`;
            notify({
              kind: "ORDER",
              title: `AI DESK — LIVE ${reason.replaceAll("_", " ")}${partialTag}`,
              body: `${p.question.slice(0, 56)} — ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} net`,
              href: "/ai",
            });
            sendLiveMail({
              kind: "CLOSE",
              key: `close:${p.decisionId}:${fullClose ? "full" : now}`,
              title: `${reason.replaceAll("_", " ")}${partialTag} — ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} NET`,
              detail: `${p.outcome.toUpperCase()} ${fullClose ? "closed" : "partially closed"} at ${(exitPx * 100).toFixed(1)}¢ avg (entry ${(p.entryPrice * 100).toFixed(1)}¢) for ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} after fees.`,
              market: p.question,
              outcome: p.outcome,
              entryPrice: p.entryPrice,
              exitPrice: exitPx,
              sizeUsd: p.costUsd * frac,
              pnlUsd: pnl,
              reason,
              kpi: liveMailKpi(),
            });
          } catch {
            /* book/order fault — retry next tick */
          }
        }
      } finally {
        liveClosing.current = false;
      }
    };
    const t = setInterval(() => void tick(), 5_000);
    void tick();
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.executionMode, desk.liveExecuted.length, phantomWalletClient, phantomAddress, sessReady]);
}
