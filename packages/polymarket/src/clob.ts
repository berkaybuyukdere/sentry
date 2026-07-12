import type { HistoryInterval, OrderBook, PricePoint, PriceHistoryResponse } from "./types";

export const CLOB_BASE = "https://clob.polymarket.com";

export async function fetchPriceHistory(
  tokenId: string,
  interval: HistoryInterval,
  fidelityMinutes?: number,
): Promise<PricePoint[]> {
  const p = new URLSearchParams({ market: tokenId, interval });
  if (fidelityMinutes) p.set("fidelity", String(fidelityMinutes));
  const res = await fetch(`${CLOB_BASE}/prices-history?${p}`);
  if (!res.ok) throw new Error(`clob /prices-history ${res.status}`);
  const data = (await res.json()) as PriceHistoryResponse;
  return data.history ?? [];
}

export async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`clob /book ${res.status}`);
  return (await res.json()) as OrderBook;
}

export async function fetchMidpoint(tokenId: string): Promise<number | null> {
  const res = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { mid?: string };
  return data.mid ? Number(data.mid) : null;
}

/** Aggregate executable stats from a book snapshot. */
export function bookStats(book: OrderBook) {
  const bids = book.bids.map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  const asks = book.asks.map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  // CLOB returns bids ascending / asks descending from best — normalize: best first
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const bidDepthUsd = bids.reduce((s, l) => s + l.price * l.size, 0);
  const askDepthUsd = asks.reduce((s, l) => s + (1 - l.price) * l.size, 0);
  const imbalance =
    bidDepthUsd + askDepthUsd > 0 ? (bidDepthUsd - askDepthUsd) / (bidDepthUsd + askDepthUsd) : 0;
  return { bids, asks, bestBid, bestAsk, bidDepthUsd, askDepthUsd, imbalance };
}

/** Estimate average fill price for a market buy of `usd` dollars against the asks. */
export function estimateFill(
  asks: { price: number; size: number }[],
  usd: number,
): { avgPrice: number; shares: number; filledUsd: number; exhausted: boolean } {
  let remaining = usd;
  let shares = 0;
  let cost = 0;
  for (const level of asks) {
    if (remaining <= 0) break;
    const levelUsd = level.price * level.size;
    const take = Math.min(remaining, levelUsd);
    const takenShares = take / level.price;
    shares += takenShares;
    cost += take;
    remaining -= take;
  }
  return {
    avgPrice: shares > 0 ? cost / shares : 0,
    shares,
    filledUsd: cost,
    exhausted: remaining > 0.005,
  };
}

/** Estimate proceeds of selling `shares` into the bid stack (market exit). */
export function estimateSell(
  bids: { price: number; size: number }[],
  shares: number,
): { avgPrice: number; proceedsUsd: number; filledShares: number; exhausted: boolean } {
  let remaining = shares;
  let proceeds = 0;
  let filled = 0;
  for (const level of bids) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    proceeds += take * level.price;
    filled += take;
    remaining -= take;
  }
  return {
    avgPrice: filled > 0 ? proceeds / filled : 0,
    proceedsUsd: proceeds,
    filledShares: filled,
    exhausted: remaining > 0.01,
  };
}
