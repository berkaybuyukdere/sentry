# SENTRY

**Prediction market intelligence terminal.** An institutional operating layer over Polymarket —
live market intelligence, wallet dossiers, signal detection, watchlist monitoring, and real
non-custodial trading, in one dark, precise, data-first workspace.

> *"I am not gambling. I am operating an intelligence system."*

## Monorepo

```
apps/
  web/         — the terminal (React 19 + Vite + Tailwind 4, TanStack Query, Zustand, wagmi/viem)
  api/         — app backend scaffold (Fastify): accounts, persistence, push — phase 7+
  ingestion/   — signals service scaffold: shared signal kernel run server-side — phase 4/5
packages/
  polymarket/  — typed client: Gamma, CLOB, Data-API, market WebSocket, intelligence kernel
```

## Run

```bash
pnpm install
pnpm dev          # → http://localhost:5180
```

No environment variables, no backend, no database required — the terminal talks directly to
Polymarket's public APIs (CORS-open) and derives all intelligence client-side.

## Data (all real, no mocks)

| Link | Source | Use |
|---|---|---|
| Market metadata | `gamma-api.polymarket.com` | universe, probabilities, Δ1h/24h/7d, volume, liquidity, tags |
| Books + history | `clob.polymarket.com` | order books, price series, midpoints |
| Live quotes | `wss://ws-subscriptions-clob.polymarket.com` | top-of-book + last trade, frame-batched |
| Tape / wallets | `data-api.polymarket.com` | global fill tape, positions, activity, holders, leaderboard |

The **signal engine** (whale entries, wallet clusters, smart-money entries, volume anomalies,
probability acceleration, tape momentum) is a pure kernel in `packages/polymarket/src/intel.ts`,
computed from observed data only — shared verbatim between the browser and the ingestion service.

## Trading (non-custodial, real)

- Wallet link via wagmi (injected / Coinbase) on **Polygon**.
- One-time on-chain provisioning: USDC + CTF approvals to the Polymarket exchange contracts,
  executed from the user's own wallet inside the execution panel.
- Orders are built to Polymarket's CLOB spec, signed **client-side** (EIP-712, signatureType 0 EOA,
  neg-risk aware), submitted with L1-derived / L2-HMAC API auth. SENTRY never holds keys or funds.
- Copy engine ships in **manual-signal mode** by design: tracked-operator fills surface as review
  signals; every mirrored order is signed by the user. Unattended mirroring (session keys / ERC-4337)
  is a deliberately separate future tier — see plan §4.

## Notes

- Trading requires a wallet funded with USDC.e on Polygon and is subject to Polymarket's own
  jurisdiction/geoblocking enforcement at the CLOB layer; errors surface verbatim in the ticket.
- Public-API poll cadences are deliberately conservative. Higher-resolution signals belong in
  `apps/ingestion` (TimescaleDB + Redis + gateway), scaffolded and documented in the plan.
