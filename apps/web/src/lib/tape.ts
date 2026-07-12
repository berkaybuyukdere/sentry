import { create } from "zustand";
import { fetchTrades, type DataTrade } from "@sentry-app/polymarket";

/**
 * Rolling live tape of Polymarket fills (taker side), polled from the Data-API.
 * Single global buffer; signal engine, activity feeds and copy engine read from it.
 */
interface TapeState {
  trades: DataTrade[]; // newest first, deduped
  lastPollAt: number | null;
  polling: boolean;
  error: string | null;
  _seen: Set<string>;
  start: () => void;
  stop: () => void;
}

const MAX_BUFFER = 2000;
const POLL_MS = 12_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

const tradeKey = (t: DataTrade) => `${t.transactionHash}|${t.asset}|${t.proxyWallet}|${t.timestamp}|${t.size}`;

export const useTape = create<TapeState>((set, get) => ({
  trades: [],
  lastPollAt: null,
  polling: false,
  error: null,
  _seen: new Set(),

  start: () => {
    if (timer) return;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const incoming = await fetchTrades({ limit: 200, takerOnly: true });
        const { trades, _seen } = get();
        const fresh: DataTrade[] = [];
        for (const t of incoming) {
          const k = tradeKey(t);
          if (!_seen.has(k)) {
            _seen.add(k);
            fresh.push(t);
          }
        }
        if (fresh.length) {
          const merged = [...fresh, ...trades]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, MAX_BUFFER);
          // keep the seen-set bounded alongside the buffer
          if (_seen.size > MAX_BUFFER * 2) {
            const keep = new Set(merged.map(tradeKey));
            set({ trades: merged, lastPollAt: Date.now(), error: null, _seen: keep });
          } else {
            set({ trades: merged, lastPollAt: Date.now(), error: null });
          }
        } else {
          set({ lastPollAt: Date.now(), error: null });
        }
      } catch (e) {
        set({ error: e instanceof Error ? e.message : "tape poll failed" });
      } finally {
        inFlight = false;
      }
    };
    void poll();
    timer = setInterval(poll, POLL_MS);
    set({ polling: true });
  },

  stop: () => {
    if (timer) clearInterval(timer);
    timer = null;
    set({ polling: false });
  },
}));
