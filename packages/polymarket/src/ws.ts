import type { WsMarketMessage } from "./types";

export const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type Listener = (msg: WsMarketMessage) => void;

/**
 * Single multiplexed connection to the CLOB market channel.
 * Consumers register interest in asset ids; the manager reconnects with the
 * union of all active subscriptions (the channel requires re-subscribing on
 * change), with exponential backoff on failure.
 */
export class MarketStream {
  private ws: WebSocket | null = null;
  private assets = new Map<string, number>(); // asset id -> refcount
  private listeners = new Set<Listener>();
  private backoff = 1000;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  onStatus?: (s: "connected" | "connecting" | "down") => void;

  subscribe(assetIds: string[], listener: Listener): () => void {
    this.listeners.add(listener);
    let changed = false;
    for (const id of assetIds) {
      const n = this.assets.get(id) ?? 0;
      this.assets.set(id, n + 1);
      if (n === 0) changed = true;
    }
    if (changed) this.resync();
    return () => {
      this.listeners.delete(listener);
      let removed = false;
      for (const id of assetIds) {
        const n = this.assets.get(id) ?? 0;
        if (n <= 1) {
          this.assets.delete(id);
          removed = true;
        } else {
          this.assets.set(id, n - 1);
        }
      }
      if (removed) this.resync();
    };
  }

  private resync() {
    // The market channel takes its asset list at connect time; simplest
    // correct behavior is to re-open with the current union.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), 150); // debounce bursts
  }

  private open() {
    this.closeSocket();
    if (this.assets.size === 0) {
      this.onStatus?.("down");
      return;
    }
    this.closed = false;
    this.onStatus?.("connecting");
    const ws = new WebSocket(CLOB_WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.onStatus?.("connected");
      ws.send(JSON.stringify({ assets_ids: [...this.assets.keys()], type: "market" }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "PONG") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      for (const m of msgs) {
        if (m && typeof m === "object" && "event_type" in m) {
          for (const l of this.listeners) l(m as WsMarketMessage);
        }
      }
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closed) return;
      this.onStatus?.("down");
      this.reconnectTimer = setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }

  private closeSocket() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  destroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.listeners.clear();
    this.assets.clear();
  }
}
