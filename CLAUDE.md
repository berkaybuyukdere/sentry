# SENTRY — Claude Context

Palantir-style, **fully anonymous** Polymarket intelligence + **non-custodial** trading
terminal. Core promise: "I am not gambling, I am operating an intelligence system."
This file is the durable project brain — any Claude session on any machine should read
it before touching code. Extend the system; do not rebuild or re-litigate settled
decisions.

## Commands

- Install: `pnpm install` (repo root; pnpm monorepo)
- Dev: `pnpm dev` → http://localhost:5180 (or `.claude/launch.json` name `sentry-web`)
- Typecheck: `./node_modules/.bin/tsc -p apps/web --noEmit` — **run from repo root**
- After adding a dependency, if HMR breaks: stop dev server, `rm -rf apps/web/node_modules/.vite`, restart.

## Layout

- `apps/web` — the terminal (React 19 + Vite 6 + Tailwind v4). Everything lives here.
- `packages/polymarket` (`@sentry-app/polymarket`) — typed Gamma/CLOB/Data-API/WS client + intel kernel (`intel.ts`).
- `apps/api`, `apps/ingestion` — scaffolds only.

## Non-negotiable doctrine

- **Anonymous**: no email/registration/PII anywhere. Auto callsigns (OP-XXXX), local state.
- **Non-custodial**: the user's wallet signs every order; SENTRY never holds keys or funds.
- **Real data only**: never mock, never fake a signal, never pretend a win rate. When
  reality is limiting (quiet market, no 90%-win wallets), say so in the UI honestly.
- **No casino/gamification mechanics.** System voice copy (EXECUTED / MONITORING / uppercase labels).
- **Design tokens only**: `--sv-*` CSS vars in `apps/web/src/styles/app.css`, dual theme
  (`:root[data-theme]` dark "INTEL DARK" / light "DAYLIGHT OPS"). Never hardcode colors;
  canvases read tokens via `pal()` in `lib/theme.ts`. 0–2px radius, hairline borders, no shadows.
- Fees must stay ≤ Polymarket Builder ceiling (1% taker). "We earn when we execute — never from P&L."
- **Never commit credentials.** The user's builder/CLOB keys live in localStorage only.

## CLOB v2 — hard-won facts (April 2026 migration; do NOT regress these)

1. **Hand-rolled order signing is permanently dead.** The server's V2 EIP-712 type hash
   differs from all published sources; only the official `@polymarket/client` (npm,
   0.1.0-beta.x) produces accepted signatures. All placement goes through
   `lib/trading/v2client.ts` → `getV2Client(walletClient, address)` →
   `client.placeMarketOrder / placeLimitOrder`. Reference evidence:
   github.com/kollikrishnarao/polymarket-endpoints-test `v2-discovery.md`.
2. **Direct EOA makers are banned** ("maker address not allowed"). Orders execute from
   the account's deterministic **Polymarket Deposit Wallet**; `createSecureClient`
   derives + sets it up (gasless) when `wallet:` is omitted. The derived address is
   cached in localStorage (`sentry.depositWallet.<eoa>`, read via `cachedDepositWallet`).
   Funding = plain ERC-20 transfer EOA → deposit wallet (UI: AI desk LIVE panel →
   TRADING WALLET block).
3. **V2 collateral is pUSD** (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`) alongside
   USDC.e (`0x2791…4174`). LIVE bankroll reads the deposit wallet's USDC.e + pUSD sum.
4. V2 orders are **gasless EIP-712**; the official client manages its own approvals
   (`client.setupTradingApprovals()`, auto-retried on allowance errors in
   `lib/trading/orders.ts`). The legacy 5-grant provisioning panel is informational only.
5. V2 domain: name "Polymarket CTF Exchange", version "2", verifyingContract
   `0xe111180000d2663c0091e4f400237545b87b996b`; struct includes timestamp(ms)/metadata/builder.
6. Read endpoints (gamma, data-api, CLOB books, L2 HMAC reads) are V1-compatible and
   stay on our own client in `packages/polymarket`.
7. Gamma caps every response at 100 rows; `fetchMarkets` paginates transparently — don't
   add manual paging.

## AI Operations desk (`apps/web/src/lib/aiDesk.ts` — the core engine)

- `sweepUniverse()`: ~2,400-market universe (`useDeskUniverse`), cross-sectional
  z-scores (winsorized ±3σ) + tape flow + decayed signals → alpha → drift-diffusion
  barrier model P(TP before SL) → net EV after spread (EV>0 gate + real-signal
  eligibility) → fractional-Kelly sizing → round-robin domain plan.
- **FREE WILL mode** (default): user sets only capital + target; `effectiveDeskConfig`
  derives clips (0.2–3% of live equity), max positions, TP/SL/hold from tempo, loss
  brake = 10% of bank.
- **Entries**: depth-clipped (≤½ of ask-side dollars within 1% of best ask), walk-guard
  (never pay >1% above quoted best ask — crossing the spread is fine, walking the book is not).
- **Exits**: marks come from live books fetched in parallel each 4s tick (frozen-mark bug
  fix); SL needs 2 consecutive real-mid breaches; **take-profits only close if the
  bid-side sell is net-positive after fees** (mid running ahead of exit liquidity was
  producing red "wins"); TP distance must clear the FULL spread + 0.2¢.
- **Deployment ladder**: `deployCapFrac` = clamp(0.55 + realized/capital×4, 0.25, 0.7).
- **Live spot/futures layer** (`lib/liveRef.ts`): Binance klines (BTC/ETH/SOL/XRP/DOGE/
  GOLD-via-PAXG) + perp funding; crypto-linked markets: against-tape = veto, with-tape =
  alpha boost (+ funding agreement bonus), **flat tape passes through** (a flat veto was
  silently killing all BTC up/down entries). Yahoo Finance has no usable browser API (CORS).
- **Elite operator flow** (`lib/smartFlow.ts`): scores 7d/30d/all leaderboards by REAL
  realized win rate; ≥90% wallets take priority, else best ≥70% floor — labeled with
  true measured rates (verified: top-of-leaderboard real win rates were ~87/83%).
  Fresh elite BUYs boost sweep alpha.
- **PAPER** = fully autonomous vs real books, tier fees simulated. **LIVE ARM** =
  autopilot: desk stages + submits by itself; the wallet signature is the only human
  step (protocol-required). LIVE bankroll = min(deposit-wallet balance, DESK BUDGET);
  target/loss halts measured from real wallet-balance delta vs engage baseline.
- Honest ceiling: trade count is bounded by real EV-positive opportunities, not config.

## Funding / Treasury

- Polymarket settles ONLY on Polygon. Phantom works via its Polygon (EVM) side; SOL/USDC
  on the Solana network must be **bridged** (Jumper/Relay/deBridge — Treasury has a
  pre-filled runbook card; Phantom's "Send" cannot cross chains). Keep ~0.5 POL for gas
  (approvals/transfers; v2 orders themselves are gasless).
- Treasury screen: deposit address + withdraw (review → sign) for USDC.e/USDC/POL.

## Other load-bearing modules

- `lib/billing.ts` — tiers ACCESS/OPERATOR/PRO/BLACK, fee quotes accrue only on fills.
- `lib/trading/clobAuth.ts` — L1/L2 CLOB auth (legacy reads); `lib/trading/provision.ts`
  — legacy approvals + POL/USDC.e preflight (`gasReady`).
- `components/market/ExecutionPanel.tsx` — ticket; ARM `auto` flag auto-fires execute,
  auto-closes on done/error so the desk continues.
- `lib/session.ts` — anonymous auth channels; `lib/copy.ts` — copy engine polling.
- User is a registered Polymarket builder (`sentinelmarket`); builder code is entered in
  Settings and attached to V2 orders via `builderCode`.

## Verification habits

- Typecheck from repo root; verify UI in a **fresh browser tab** (editing hook-bearing
  modules under Vite HMR logs a one-time bogus Rules-of-Hooks error in already-open tabs).
- Check both themes when touching UI. Never fake progress in the UI to look busy.
