import type { DataTrade, GammaEventRaw, LeaderboardEntry, Market } from "./types";

/**
 * Intelligence derivation layer.
 * Everything here is computed from real observed data — no synthetic values.
 * Each function is pure so signal generation is deterministic and testable.
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalType =
  | "WHALE_ENTRY"
  | "SMART_WALLET_ENTRY"
  | "SMART_WALLET_CLUSTER"
  | "CLUSTER_ENTRY"
  | "PROBABILITY_ACCELERATION"
  | "VOLUME_ANOMALY"
  | "TAPE_MOMENTUM";

export type Severity = "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";

export interface Signal {
  id: string;
  type: SignalType;
  severity: Severity;
  confidence: number; // 0..1
  ts: number; // unix seconds
  title: string;
  detail: string;
  conditionId?: string;
  marketTitle?: string;
  marketSlug?: string;
  eventSlug?: string;
  side?: "BUY" | "SELL";
  outcome?: string;
  wallets: string[];
  walletNames: string[];
  usd: number;
}

export interface TradeWindowStats {
  trades: number;
  usd: number;
  buyUsd: number;
  sellUsd: number;
  uniqueWallets: number;
}

const tradeUsd = (t: DataTrade) => t.size * t.price;

/** Wallets currently on the profitability leaderboard = the smart-money cohort. */
export function smartWalletSet(leaderboard: LeaderboardEntry[]): Map<string, LeaderboardEntry> {
  const m = new Map<string, LeaderboardEntry>();
  for (const e of leaderboard) m.set(e.proxyWallet.toLowerCase(), e);
  return m;
}

export interface SignalScanOptions {
  whaleUsd: number; // single-trade notional threshold
  clusterWallets: number; // distinct wallets for a cluster
  clusterWindowSec: number;
  clusterUsd: number; // combined notional for a cluster
  smartClusterWallets: number;
}

export const DEFAULT_SCAN: SignalScanOptions = {
  whaleUsd: 10_000,
  clusterWallets: 4,
  clusterWindowSec: 15 * 60,
  clusterUsd: 25_000,
  smartClusterWallets: 2,
};

/**
 * Scan a rolling buffer of tape trades (newest-first or any order) and emit signals.
 * Deterministic ids let callers dedupe across successive scans.
 */
export function scanTape(
  trades: DataTrade[],
  smart: Map<string, LeaderboardEntry>,
  opts: SignalScanOptions = DEFAULT_SCAN,
): Signal[] {
  const signals: Signal[] = [];
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  // --- single-trade signals: whales + smart wallets -----------------------
  for (const t of sorted) {
    const usd = tradeUsd(t);
    const isSmart = smart.has(t.proxyWallet.toLowerCase());
    if (usd >= opts.whaleUsd) {
      signals.push({
        id: `WH-${t.transactionHash.slice(2, 10)}`,
        type: "WHALE_ENTRY",
        severity: usd >= opts.whaleUsd * 5 ? "HIGH" : "ELEVATED",
        confidence: Math.min(0.55 + usd / 400_000, 0.95),
        ts: t.timestamp,
        title: "Large directional position detected",
        detail: `${t.side} ${t.outcome} · ${Math.round(t.size).toLocaleString()} shares @ ${(t.price * 100).toFixed(1)}¢`,
        conditionId: t.conditionId,
        marketTitle: t.title,
        marketSlug: t.slug,
        eventSlug: t.eventSlug,
        side: t.side,
        outcome: t.outcome,
        wallets: [t.proxyWallet],
        walletNames: [t.name || t.pseudonym || short(t.proxyWallet)],
        usd,
      });
    } else if (isSmart && usd >= 500) {
      const entry = smart.get(t.proxyWallet.toLowerCase())!;
      signals.push({
        id: `SW-${t.transactionHash.slice(2, 10)}`,
        type: "SMART_WALLET_ENTRY",
        severity: usd >= 5_000 ? "HIGH" : "ELEVATED",
        confidence: 0.7,
        ts: t.timestamp,
        title: "Leaderboard operator active",
        detail: `${entry.userName || short(t.proxyWallet)} · ${t.side} ${t.outcome} @ ${(t.price * 100).toFixed(1)}¢`,
        conditionId: t.conditionId,
        marketTitle: t.title,
        marketSlug: t.slug,
        eventSlug: t.eventSlug,
        side: t.side,
        outcome: t.outcome,
        wallets: [t.proxyWallet],
        walletNames: [entry.userName || short(t.proxyWallet)],
        usd,
      });
    }
  }

  // --- cluster detection: N distinct wallets, same market+side, in window --
  const groups = new Map<string, DataTrade[]>();
  for (const t of sorted) {
    const key = `${t.conditionId}|${t.side}|${t.outcomeIndex}`;
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }
  for (const [key, g] of groups) {
    // sliding window over the group's trades
    let lo = 0;
    let best: { wallets: Set<string>; usd: number; from: number; to: number } | null = null;
    for (let hi = 0; hi < g.length; hi++) {
      while (g[hi].timestamp - g[lo].timestamp > opts.clusterWindowSec) lo++;
      const slice = g.slice(lo, hi + 1);
      const wallets = new Set(slice.map((t) => t.proxyWallet.toLowerCase()));
      const usd = slice.reduce((s, t) => s + tradeUsd(t), 0);
      if (wallets.size >= opts.clusterWallets && usd >= opts.clusterUsd) {
        if (!best || usd > best.usd) {
          best = { wallets, usd, from: g[lo].timestamp, to: g[hi].timestamp };
        }
      }
    }
    if (best) {
      const sample = g[g.length - 1];
      const smartCount = [...best.wallets].filter((w) => smart.has(w)).length;
      const isSmartCluster = smartCount >= opts.smartClusterWallets;
      const spanMin = Math.max(1, Math.round((best.to - best.from) / 60));
      signals.push({
        id: `CL-${key.slice(2, 8)}-${best.to}`,
        type: isSmartCluster ? "SMART_WALLET_CLUSTER" : "CLUSTER_ENTRY",
        severity: isSmartCluster ? "CRITICAL" : "HIGH",
        confidence: isSmartCluster ? 0.85 : 0.65,
        ts: best.to,
        title: isSmartCluster
          ? `${smartCount} leaderboard wallets entered within ${spanMin}m`
          : `${best.wallets.size} wallets entered within ${spanMin}m`,
        detail: `${sample.side} ${sample.outcome} · combined ${fmtUsd(best.usd)}`,
        conditionId: sample.conditionId,
        marketTitle: sample.title,
        marketSlug: sample.slug,
        eventSlug: sample.eventSlug,
        side: sample.side,
        outcome: sample.outcome,
        wallets: [...best.wallets],
        walletNames: [...best.wallets].map(short),
        usd: best.usd,
      });
    }
  }

  // --- tape momentum: per-market trade-rate burst --------------------------
  const byMarket = new Map<string, DataTrade[]>();
  for (const t of sorted) {
    const arr = byMarket.get(t.conditionId);
    if (arr) arr.push(t);
    else byMarket.set(t.conditionId, [t]);
  }
  const now = sorted.length ? sorted[sorted.length - 1].timestamp : 0;
  for (const [cid, g] of byMarket) {
    if (g.length < 12) continue;
    const recent = g.filter((t) => now - t.timestamp <= 300);
    const older = g.filter((t) => now - t.timestamp > 300);
    if (recent.length >= 10 && older.length >= 4) {
      const recentRate = recent.length / 5;
      const span = Math.max(5, (older[older.length - 1].timestamp - older[0].timestamp) / 60);
      const olderRate = older.length / span;
      if (olderRate > 0 && recentRate / olderRate >= 3) {
        const sample = recent[recent.length - 1];
        const usd = recent.reduce((s, t) => s + tradeUsd(t), 0);
        signals.push({
          id: `TM-${cid.slice(2, 8)}-${Math.floor(now / 300)}`,
          type: "TAPE_MOMENTUM",
          severity: "ELEVATED",
          confidence: 0.6,
          ts: sample.timestamp,
          title: `Trade rate ${(recentRate / olderRate).toFixed(1)}× above baseline`,
          detail: `${recent.length} fills in 5m · ${fmtUsd(usd)} notional`,
          conditionId: cid,
          marketTitle: sample.title,
          marketSlug: sample.slug,
          eventSlug: sample.eventSlug,
          wallets: [],
          walletNames: [],
          usd,
        });
      }
    }
  }

  return signals.sort((a, b) => b.ts - a.ts);
}

/** Market-snapshot anomalies from Gamma metrics (no tape required). */
export function scanMarkets(markets: Market[]): Signal[] {
  const signals: Signal[] = [];
  const eligible = markets.filter((m) => m.volume24h > 1000 && m.liquidity > 500);

  // volume anomaly: 24h volume large relative to open liquidity
  const ratios = eligible.map((m) => m.volume24h / Math.max(m.liquidity, 1));
  const mean = avg(ratios);
  const sd = std(ratios, mean);
  eligible.forEach((m, i) => {
    const z = sd > 0 ? (ratios[i] - mean) / sd : 0;
    if (z >= 3 && m.volume24h > 25_000) {
      signals.push({
        id: `VA-${m.conditionId.slice(2, 8)}`,
        type: "VOLUME_ANOMALY",
        severity: z >= 6 ? "HIGH" : "ELEVATED",
        confidence: Math.min(0.5 + z / 20, 0.9),
        ts: Math.floor(Date.now() / 1000),
        title: `24h volume ${ratios[i].toFixed(1)}× open liquidity`,
        detail: `${fmtUsd(m.volume24h)} traded against ${fmtUsd(m.liquidity)} book · z ${z.toFixed(1)}`,
        conditionId: m.conditionId,
        marketTitle: m.question,
        marketSlug: m.slug,
        eventSlug: m.eventSlug ?? undefined,
        wallets: [],
        walletNames: [],
        usd: m.volume24h,
      });
    }
  });

  // probability acceleration: 1h move is a disproportionate share of the 24h move
  for (const m of eligible) {
    const h = Math.abs(m.delta1h);
    if (h >= 0.04 && m.volume24h > 10_000) {
      signals.push({
        id: `PA-${m.conditionId.slice(2, 8)}-${Math.round(m.probability * 1000)}`,
        type: "PROBABILITY_ACCELERATION",
        severity: h >= 0.1 ? "HIGH" : "ELEVATED",
        confidence: Math.min(0.5 + h * 3, 0.9),
        ts: Math.floor(Date.now() / 1000),
        title: `Probability moved ${(h * 100).toFixed(1)}pp in the last hour`,
        detail: `${((m.probability - m.delta1h) * 100).toFixed(1)}% → ${(m.probability * 100).toFixed(1)}%`,
        conditionId: m.conditionId,
        marketTitle: m.question,
        marketSlug: m.slug,
        eventSlug: m.eventSlug ?? undefined,
        wallets: [],
        walletNames: [],
        usd: m.volume24h,
      });
    }
  }

  return signals.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

export function severityRank(s: Severity): number {
  return { LOW: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 }[s];
}

// ---------------------------------------------------------------------------
// Narratives — tag-level aggregation of capital + movement
// ---------------------------------------------------------------------------

export interface Narrative {
  tag: string;
  slug: string;
  volume24h: number;
  liquidity: number;
  openInterest: number;
  events: number;
  markets: number;
  /** volume-weighted mean |Δ24h| across constituent markets */
  agitation: number;
  topEvents: { title: string; slug: string; volume24h: number }[];
}

const NARRATIVE_EXCLUDE = new Set(["all", "recurring", "hide-from-new"]);

export function deriveNarratives(events: GammaEventRaw[]): Narrative[] {
  const map = new Map<string, Narrative & { moveWeight: number; moveSum: number }>();
  for (const ev of events) {
    const tags = (ev.tags ?? []).filter((t) => !NARRATIVE_EXCLUDE.has(t.slug));
    if (!tags.length) continue;
    const vol = ev.volume24hr ?? 0;
    let moveSum = 0;
    let moveWeight = 0;
    for (const m of ev.markets ?? []) {
      const v = m.volume24hr ?? 0;
      moveSum += Math.abs(m.oneDayPriceChange ?? 0) * v;
      moveWeight += v;
    }
    for (const t of tags) {
      let n = map.get(t.slug);
      if (!n) {
        n = {
          tag: t.label,
          slug: t.slug,
          volume24h: 0,
          liquidity: 0,
          openInterest: 0,
          events: 0,
          markets: 0,
          agitation: 0,
          topEvents: [],
          moveWeight: 0,
          moveSum: 0,
        };
        map.set(t.slug, n);
      }
      n.volume24h += vol;
      n.liquidity += ev.liquidity ?? 0;
      n.openInterest += ev.openInterest ?? 0;
      n.events += 1;
      n.markets += ev.markets?.length ?? 0;
      n.moveSum += moveSum;
      n.moveWeight += moveWeight;
      n.topEvents.push({ title: ev.title, slug: ev.slug, volume24h: vol });
    }
  }
  return [...map.values()]
    .map((n) => ({
      ...n,
      agitation: n.moveWeight > 0 ? n.moveSum / n.moveWeight : 0,
      topEvents: n.topEvents.sort((a, b) => b.volume24h - a.volume24h).slice(0, 4),
    }))
    .sort((a, b) => b.volume24h - a.volume24h);
}

// ---------------------------------------------------------------------------
// Ecosystem pulse
// ---------------------------------------------------------------------------

export interface Pulse {
  volume24h: number;
  liquidity: number;
  activeMarkets: number;
  highVelocity: number; // |Δ1h| ≥ 2pp
  /** share of 24h volume in markets whose probability rose over 24h, 0..1 */
  breadth: number;
  agitation: number; // volume-weighted mean |Δ24h|, pp
}

export function derivePulse(markets: Market[]): Pulse {
  let vol = 0;
  let liq = 0;
  let up = 0;
  let moveSum = 0;
  let hv = 0;
  for (const m of markets) {
    vol += m.volume24h;
    liq += m.liquidity;
    if (m.delta24h > 0.001) up += m.volume24h;
    moveSum += Math.abs(m.delta24h) * m.volume24h;
    if (Math.abs(m.delta1h) >= 0.02) hv++;
  }
  return {
    volume24h: vol,
    liquidity: liq,
    activeMarkets: markets.length,
    highVelocity: hv,
    breadth: vol > 0 ? up / vol : 0.5,
    agitation: vol > 0 ? (moveSum / vol) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Wallet dossier analytics
// ---------------------------------------------------------------------------

export interface WalletProfile {
  domain: { label: string; share: number }[];
  hourHistogram: number[]; // 24 buckets, UTC
  avgTradeUsd: number;
  medianTradeUsd: number;
  buyShare: number;
  tradesPerDay: number;
  activeDays: number;
  firstSeen: number | null;
  lastSeen: number | null;
  scaleInRate: number; // share of trades that add to an existing same-side market
}

export function profileWallet(activity: { timestamp: number; usdcSize: number; side: string; title: string; conditionId: string; type: string }[]): WalletProfile {
  const trades = activity.filter((a) => a.type === "TRADE");
  const hours = new Array(24).fill(0) as number[];
  const days = new Set<string>();
  const domainCount = new Map<string, number>();
  const seenMarketSide = new Map<string, number>();
  let scaleIns = 0;
  let buys = 0;
  const sizes: number[] = [];
  for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    const d = new Date(t.timestamp * 1000);
    hours[d.getUTCHours()]++;
    days.add(d.toISOString().slice(0, 10));
    sizes.push(t.usdcSize);
    if (t.side === "BUY") buys++;
    const dk = domainKeyFromTitle(t.title);
    domainCount.set(dk, (domainCount.get(dk) ?? 0) + t.usdcSize);
    const msKey = `${t.conditionId}|${t.side}`;
    const prev = seenMarketSide.get(msKey) ?? 0;
    if (prev > 0) scaleIns++;
    seenMarketSide.set(msKey, prev + 1);
  }
  const totalDomain = [...domainCount.values()].reduce((s, v) => s + v, 0) || 1;
  const first = trades.length ? Math.min(...trades.map((t) => t.timestamp)) : null;
  const last = trades.length ? Math.max(...trades.map((t) => t.timestamp)) : null;
  const spanDays = first && last ? Math.max(1, (last - first) / 86400) : 1;
  const sortedSizes = [...sizes].sort((a, b) => a - b);
  return {
    domain: [...domainCount.entries()]
      .map(([label, usd]) => ({ label, share: usd / totalDomain }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 6),
    hourHistogram: hours,
    avgTradeUsd: sizes.length ? avg(sizes) : 0,
    medianTradeUsd: sortedSizes.length ? sortedSizes[Math.floor(sortedSizes.length / 2)] : 0,
    buyShare: trades.length ? buys / trades.length : 0,
    tradesPerDay: trades.length / spanDays,
    activeDays: days.size,
    firstSeen: first,
    lastSeen: last,
    scaleInRate: trades.length ? scaleIns / trades.length : 0,
  };
}

/** Coarse domain classification from market titles (real taxonomy comes from event tags when available). */
export function domainKeyFromTitle(title: string): string {
  const t = title.toLowerCase();
  if (/(trump|biden|harris|election|senate|congress|president|governor|mayor|democrat|republican|parliament|minister|nominee)/.test(t)) return "Politics";
  if (/(bitcoin|btc|ethereum|eth|solana|crypto|token|coin)/.test(t)) return "Crypto";
  if (/(fed|rate|inflation|cpi|gdp|recession|tariff|treasury)/.test(t)) return "Macro";
  if (/( vs\.? | @ |nba|nfl|mlb|nhl|ufc|premier league|la liga|serie a|champions league|world cup|open|grand prix|f1|atp|wta|itf)/.test(t)) return "Sports";
  if (/(openai|ai |gpt|anthropic|google|apple|tesla|spacex|microsoft|nvidia|meta|amazon|ipo)/.test(t)) return "Tech";
  return "Other";
}

// ---------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------

export function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
export function std(xs: number[], mean?: number): number {
  if (xs.length < 2) return 0;
  const m = mean ?? avg(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
export function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
