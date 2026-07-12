import { create } from "zustand";
import { useEffect } from "react";
import { MarketStream, type WsMarketMessage } from "@sentry-app/polymarket";

/** Live top-of-book state per CLOB token, fed by the market WebSocket channel.
 *  Selector-based subscriptions: one tick re-renders only rows that watch it. */
export interface LiveQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
  lastSide: "BUY" | "SELL" | null;
  ts: number;
  rev: number; // bump for flash animations
}

interface PriceState {
  quotes: Record<string, LiveQuote>;
  wsStatus: "connected" | "connecting" | "down";
}

export const usePrices = create<PriceState>(() => ({
  quotes: {},
  wsStatus: "down",
}));

export const stream = new MarketStream();
stream.onStatus = (s) => usePrices.setState({ wsStatus: s });

// batch WS messages into one store write per frame
let pending: Record<string, Partial<LiveQuote>> = {};
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const updates = pending;
    pending = {};
    const prev = usePrices.getState().quotes;
    const next = { ...prev };
    for (const [asset, u] of Object.entries(updates)) {
      const cur = next[asset] ?? { bid: null, ask: null, last: null, lastSide: null, ts: 0, rev: 0 };
      next[asset] = { ...cur, ...u, ts: Date.now(), rev: cur.rev + 1 };
    }
    usePrices.setState({ quotes: next });
  });
}

function onMessage(msg: WsMarketMessage) {
  if (msg.event_type === "book") {
    const bestBid = msg.bids.length ? Math.max(...msg.bids.map((l) => Number(l.price))) : null;
    const bestAsk = msg.asks.length ? Math.min(...msg.asks.map((l) => Number(l.price))) : null;
    pending[msg.asset_id] = { ...pending[msg.asset_id], bid: bestBid, ask: bestAsk };
    scheduleFlush();
  } else if (msg.event_type === "last_trade_price") {
    pending[msg.asset_id] = {
      ...pending[msg.asset_id],
      last: Number(msg.price),
      lastSide: msg.side,
    };
    scheduleFlush();
  }
}

/** Subscribe a component tree to live quotes for a set of token ids. */
export function useLiveTokens(tokenIds: string[]) {
  const key = tokenIds.slice(0, 400).sort().join(",");
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    return stream.subscribe(ids, onMessage);
  }, [key]);
}

export function useQuote(tokenId: string | undefined): LiveQuote | undefined {
  return usePrices((s) => (tokenId ? s.quotes[tokenId] : undefined));
}
