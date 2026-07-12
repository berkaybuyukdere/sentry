import { create } from "zustand";

/**
 * LIVE REFERENCE FEED — real-world spot prices for crypto-linked markets.
 *
 * Yahoo Finance has no official API and its unofficial endpoints are
 * CORS-blocked in browsers; Binance's public data API is CORS-open, keyless
 * and real-time, with Coinbase spot as fallback. The desk uses this to trade
 * Polymarket crypto up/down markets WITH the live tape instead of blind.
 */

export interface RefRow {
  price: number;
  ret15m: number; // 15-minute return
  ret1h: number; // 60-minute return
  funding?: number; // perp last funding rate (8h, fraction) — futures positioning
  ts: number; // ms
}

export const REF_SYMBOLS: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
  DOGE: "DOGEUSDT",
  GOLD: "PAXGUSDT", // tokenized gold — 24/7 proxy for gold-price markets
};

interface LiveRefState {
  rows: Record<string, RefRow>;
  ok: boolean;
  start: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function fetchFunding(sym: string): Promise<number | undefined> {
  // Binance USDT-M perp funding — real futures-market positioning, keyless +
  // CORS-open. Symbols without a perp (e.g. PAXG) simply return undefined.
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${REF_SYMBOLS[sym]}`);
    if (!res.ok) return undefined;
    const j = (await res.json()) as { lastFundingRate?: string };
    const f = Number(j.lastFundingRate);
    return Number.isFinite(f) ? f : undefined;
  } catch {
    return undefined;
  }
}

async function fetchBinance(sym: string): Promise<RefRow | null> {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${REF_SYMBOLS[sym]}&interval=1m&limit=61`,
  );
  if (!res.ok) return null;
  const k = (await res.json()) as [number, string, string, string, string][];
  if (!Array.isArray(k) || k.length < 20) return null;
  const closes = k.map((row) => Number(row[4]));
  const last = closes[closes.length - 1];
  const m15 = closes[Math.max(0, closes.length - 16)];
  const m60 = closes[0];
  return { price: last, ret15m: last / m15 - 1, ret1h: last / m60 - 1, ts: Date.now() };
}

async function fetchCoinbase(sym: string, prev: RefRow | undefined): Promise<RefRow | null> {
  const res = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { amount?: string } };
  const price = Number(j.data?.amount);
  if (!price) return null;
  // no history endpoint — derive momentum from our own poll trail
  const ret15m = prev && Date.now() - prev.ts < 20 * 60_000 ? price / prev.price - 1 : 0;
  return { price, ret15m, ret1h: prev?.ret1h ?? 0, ts: Date.now() };
}

export const useLiveRef = create<LiveRefState>((set, get) => ({
  rows: {},
  ok: false,
  start: () => {
    if (timer) return;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const entries = await Promise.all(
          Object.keys(REF_SYMBOLS).map(async (sym) => {
            try {
              const [row, funding] = await Promise.all([
                fetchBinance(sym).then((r) => r ?? fetchCoinbase(sym, get().rows[sym])),
                fetchFunding(sym),
              ]);
              return [sym, row ? { ...row, funding } : row] as const;
            } catch {
              return [sym, null] as const;
            }
          }),
        );
        const rows = { ...get().rows };
        let any = false;
        for (const [sym, row] of entries) {
          if (row) {
            rows[sym] = row;
            any = true;
          }
        }
        set({ rows, ok: any });
      } finally {
        inFlight = false;
      }
    };
    void poll();
    timer = setInterval(poll, 12_000);
  },
}));

/** Match a market question to a tracked symbol. */
export function refSymbolFor(question: string): string | null {
  const q = question.toLowerCase();
  if (/\b(bitcoin|btc)\b/.test(q)) return "BTC";
  if (/\b(ethereum|eth)\b/.test(q)) return "ETH";
  if (/\bsolana\b|\bsol\b/.test(q)) return "SOL";
  if (/\bxrp\b|ripple/.test(q)) return "XRP";
  if (/\bdoge(coin)?\b/.test(q)) return "DOGE";
  if (/\bgold\b|\bxau\b/.test(q)) return "GOLD";
  return null;
}

/**
 * Directional read for a crypto market outcome against live spot momentum.
 * Returns null when the market's direction can't be inferred confidently.
 */
export function cryptoAlignment(
  question: string,
  outcome: string,
  rows: Record<string, RefRow>,
): { sym: string; dir: "with" | "against" | "flat"; ret15m: number; fundingAgree: boolean } | null {
  const sym = refSymbolFor(question);
  if (!sym) return null;
  const row = rows[sym];
  if (!row || Date.now() - row.ts > 90_000) return null;

  const o = outcome.toLowerCase();
  const q = question.toLowerCase();
  let impliedUp: boolean | null = null;
  if (o === "up") impliedUp = true;
  else if (o === "down") impliedUp = false;
  else if (/above|higher|reach|hit|exceed/.test(q)) {
    if (o === "yes") impliedUp = true;
    else if (o === "no") impliedUp = false;
  } else if (/below|under|dip/.test(q)) {
    if (o === "yes") impliedUp = false;
    else if (o === "no") impliedUp = true;
  }
  if (impliedUp === null) return null;

  // three-state read: WITH the tape (boost), AGAINST it (veto), or FLAT —
  // a flat tape is tradeable on market-native signals, it is not a veto
  const thresh = 0.0005; // 5bps of real movement over 15m
  let dir: "with" | "against" | "flat" = "flat";
  if (row.ret15m > thresh) dir = impliedUp ? "with" : "against";
  else if (row.ret15m < -thresh) dir = impliedUp ? "against" : "with";
  const f = row.funding;
  const fundingAgree =
    dir === "with" &&
    f !== undefined &&
    Math.abs(f) > 0.0001 &&
    ((impliedUp && f > 0) || (!impliedUp && f < 0));
  return { sym, dir, ret15m: row.ret15m, fundingAgree };
}
