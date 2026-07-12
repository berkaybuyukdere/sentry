import { fetchTrades, fetchLeaderboard, scanTape, smartWalletSet, type DataTrade } from "@sentry-app/polymarket";

/**
 * SENTRY ingestion + signals service — scaffold (plan §4, phase 4/5).
 *
 * Target architecture:
 *   CLOB WS + Data-API tape ─→ normalize ─→ TimescaleDB (history) + Redis (hot window)
 *                                   │
 *                                   └─→ signal jobs (clusters, wallet scoring, narratives)
 *                                              └─→ own WS/SSE gateway → terminal
 *
 * This scaffold runs the same pure signal kernel the terminal uses client-side
 * (packages/polymarket/src/intel.ts) as a standalone loop, proving the shared-kernel
 * design: when this service goes live, the terminal switches from local derivation
 * to the gateway feed without changing signal semantics.
 */

const POLL_MS = 15_000;
const buffer: DataTrade[] = [];
const seen = new Set<string>();

async function tick() {
  try {
    const [trades, leaderboard] = await Promise.all([
      fetchTrades({ limit: 200, takerOnly: true }),
      fetchLeaderboard("30d", 50),
    ]);
    for (const t of trades) {
      const k = `${t.transactionHash}|${t.asset}|${t.proxyWallet}|${t.timestamp}`;
      if (!seen.has(k)) {
        seen.add(k);
        buffer.push(t);
      }
    }
    buffer.sort((a, b) => b.timestamp - a.timestamp);
    buffer.splice(3000);
    if (seen.size > 8000) {
      seen.clear();
      for (const t of buffer) seen.add(`${t.transactionHash}|${t.asset}|${t.proxyWallet}|${t.timestamp}`);
    }

    const signals = scanTape(buffer, smartWalletSet(leaderboard));
    const top = signals.slice(0, 5);
    console.log(
      `[ingestion] buffer=${buffer.length} signals=${signals.length}` +
        (top.length ? ` | top: ${top.map((s) => `${s.type}:${s.marketTitle?.slice(0, 32)}`).join(" · ")}` : ""),
    );
    // TODO(phase 4): persist to TimescaleDB, publish deltas to gateway
  } catch (e) {
    console.error("[ingestion] tick failed:", e instanceof Error ? e.message : e);
  }
}

console.log("[ingestion] SENTRY signal service — scaffold loop starting");
await tick();
setInterval(tick, POLL_MS);
