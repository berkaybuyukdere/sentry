import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccount, useSwitchChain, useWalletClient, useReadContracts, useWriteContract } from "wagmi";
import { erc20Abi } from "viem";
import { polygon } from "wagmi/chains";
import { Bot, Power, RotateCcw, FlaskConical } from "lucide-react";
import { fmt, fetchOrderBook, bookStats, estimateSell, fetchMarketBySlug } from "@sentry-app/polymarket";
import { useMarkets, useDeskUniverse } from "../lib/queries";
import { useTicket } from "../components/market/ticket";
import { usePrices } from "../lib/prices";
import { aiDeskEnabled, useBilling, tierById, bpsPct } from "../lib/billing";
import { useLiveRef } from "../lib/liveRef";
import { useSmartFlow } from "../lib/smartFlow";
import { useNotifications } from "../lib/alerts";
import { useProvision } from "../lib/trading/provision";
import { cachedDepositWallet, getV2Client, recoverLegacyFunds } from "../lib/trading/v2client";
import { USDC, PUSD, LEGACY_DEPOSIT_WALLET } from "../lib/trading/constants";
import {
  useAiDesk,
  paperEquity,
  deployCapFrac,
  effectiveDeskConfig,
  type DeskDecision,
  type RiskProfile,
  type DeskMode,
  type ExecutionMode,
  type PaperPosition,
  type Tempo,
} from "../lib/aiDesk";
import { Panel, Btn, Tag, Metric, Empty, cx } from "../components/ui/primitives";

const DOMAINS = ["Politics", "Crypto", "Sports", "Economy", "Tech", "Culture"];

export function AiOperations() {
  const enabled = aiDeskEnabled();
  if (!enabled) return <TierGate />;
  return <Desk />;
}

function TierGate() {
  return (
    <div className="flex h-[70vh] flex-col items-center justify-center gap-4">
      <Bot size={20} strokeWidth={1.5} className="text-faint" />
      <div className="label">AI OPERATIONS REQUIRES PRO OR BLACK ACCESS</div>
      <p className="max-w-[420px] text-center text-[11.5px] leading-relaxed text-dim">
        The desk scores the live universe continuously, sizes positions inside your risk
        envelope, and manages entries and exits automatically — in paper mode with zero funds
        at risk, or in live mode where your wallet approves every order.
      </p>
      <Link
        to="/pricing"
        className="focus-outline flex h-9 items-center border border-accent/60 bg-accent/10 px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-accent2 transition-colors hover:bg-accent/20"
      >
        VIEW ACCESS TIERS
      </Link>
    </div>
  );
}

function Desk() {
  const desk = useAiDesk();
  const { config, engaged, haltReason, decisions, paper, aiStatus, scan } = desk;
  const { data: markets } = useMarkets({ limit: 400 }, 45_000);
  const { data: deskUniverse } = useDeskUniverse(25_000);
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const notify = useNotifications((s) => s.push);
  const eliteOps = useSmartFlow((s) => s.elite);
  const prov = useProvision();
  const { data: walletClient } = useWalletClient();
  const { writeContract: depositWrite, isPending: depositPending } = useWriteContract();
  const [linking, setLinking] = useState(false);
  // CLOB v2 executes from the Polymarket Deposit Wallet, not the EOA
  const { address } = useAccount();
  const depositWallet = address ? cachedDepositWallet(address) : null;
  const twReads = useReadContracts({
    contracts: depositWallet
      ? [
          { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [depositWallet] },
          { address: PUSD, abi: erc20Abi, functionName: "balanceOf", args: [depositWallet] },
          // beta client's self-derived wallet — stranded-fund recovery source
          { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [LEGACY_DEPOSIT_WALLET] },
        ]
      : [],
    query: { enabled: !!depositWallet, refetchInterval: 15_000 },
  });
  const twUsdcBal = twReads.data ? Number((twReads.data[0]?.result as bigint | undefined) ?? 0n) / 1e6 : null;
  const twPusdBal = twReads.data ? Number((twReads.data[1]?.result as bigint | undefined) ?? 0n) / 1e6 : null;
  const tradingBal = twReads.data ? (twUsdcBal ?? 0) + (twPusdBal ?? 0) : null;
  const legacyUnits = (twReads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const legacyBal = twReads.data ? Number(legacyUnits) / 1e6 : 0;
  const [recovering, setRecovering] = useState(false);

  const recoverStranded = async () => {
    if (!walletClient || !address || legacyUnits === 0n) return;
    setRecovering(true);
    console.info("%c[SENTRY] recovering stranded funds from legacy deposit wallet…", "color:#59f");
    try {
      const txHash = await recoverLegacyFunds(walletClient, address, legacyUnits);
      console.info(`%c[SENTRY] RECOVERED — tx ${txHash}`, "color:#3a5;font-weight:bold");
      notify({
        kind: "SYSTEM",
        title: "FUNDS RECOVERED",
        body: `${fmt.usd(legacyBal, { compact: false })} returned to your wallet — tx ${txHash.slice(0, 14)}…`,
        href: "/treasury",
      });
      void twReads.refetch();
    } catch (e) {
      console.error("[SENTRY] recovery failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      notify({ kind: "SYSTEM", title: "RECOVERY FAILED", body: msg.slice(0, 200), href: "/ai" });
    } finally {
      setRecovering(false);
    }
  };
  // CLOB v2 settles ONLY in pUSD — USDC.e sitting in the deposit wallet reads
  // as spendable balance here (it's real money) but the exchange contract
  // sees zero collateral until it's converted 1:1 on polymarket.com
  // ("Balance migration" banner). Verified live 2026-07-13: pUSD carried a
  // full allowance to the v2 exchange from setupTradingApprovals() while
  // actual pUSD balance was $0 — every order bounced "balance: 0" regardless.
  const needsPusdConversion = (twUsdcBal ?? 0) > 0.5 && (twPusdBal ?? 0) < 0.5;

  const linkTradingWallet = async () => {
    if (!walletClient || !address) return;
    setLinking(true);
    console.info("%c[SENTRY] linking trading wallet — authenticating + deposit-wallet setup…", "color:#59f");
    try {
      const client = await getV2Client(walletClient, address);
      console.info(
        `%c[SENTRY] TRADING WALLET LINKED — signer ${client.account.signer} → wallet ${client.account.wallet} (${client.account.walletType})`,
        "color:#3a5;font-weight:bold",
      );
      notify({ kind: "SYSTEM", title: "TRADING WALLET LINKED", body: `Deposit wallet ${client.account.wallet.slice(0, 10)}… ready — fund it to trade.`, href: "/ai" });
    } catch (e) {
      // full detail to console (debugFetch also prints the raw server body for
      // clob.polymarket.com/auth* and relayer-v2 calls made during this step)
      console.error("[SENTRY] linkTradingWallet failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      notify({ kind: "SYSTEM", title: "TRADING WALLET LINK FAILED", body: msg.slice(0, 200), href: "/ai" });
    } finally {
      setLinking(false);
    }
  };

  const depositToTrading = () => {
    if (!depositWallet || !prov.usdcBalance || prov.usdcBalance < 0.5) return;
    depositWrite({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [depositWallet, BigInt(Math.floor(prov.usdcBalance * 1e6))],
    });
  };
  const quotes = usePrices((s) => s.quotes);
  const stage = useTicket((s) => s.stage);
  const navigate = useNavigate();
  const billing = useBilling((s) => s.quote);
  const signalRate = tierById(useBilling((s) => s.tier)).rates.SIGNAL;
  const paperMode = config.executionMode === "PAPER";

  const markOf = (tokenId: string, fallback: number): number => {
    const q = quotes[tokenId];
    if (q?.last != null) return q.last;
    if (q?.bid != null) return q.bid;
    if (markets) {
      for (const m of markets) {
        const i = m.clobTokenIds.indexOf(tokenId);
        if (i >= 0) return m.outcomePrices[i] ?? fallback;
      }
    }
    return fallback;
  };

  const equity = paperEquity(paper, markOf);
  const realized = paper.closed.reduce((s, t) => s + t.pnl, 0);
  const capFrac = deployCapFrac(realized, Math.max(paper.startingCapital, 1));
  const liveRefOk = useLiveRef((s) => s.ok);
  const unrealized = paper.positions.reduce(
    (s, p) => s + (markOf(p.tokenId, p.entryPrice) - p.entryPrice) * p.shares,
    0,
  );
  const sessionPnl = equity - paper.startingCapital;
  const wins = paper.closed.filter((t) => t.pnl > 0).length;
  const targetProgress = Math.min(Math.max(sessionPnl / Math.max(config.targetProfitUsd, 1), 0), 1);
  // live-derived envelope shown when FREE WILL is on — same math the engine
  // runs; in LIVE mode the bankroll is the wallet's real Polygon USDC.e
  const fwBase = paperMode
    ? (paper.active ? equity : config.startingCapitalUsd)
    : Math.min((depositWallet ? tradingBal : prov.usdcBalance) ?? config.budgetUsd, config.budgetUsd);
  const eff = effectiveDeskConfig(config, fwBase, paper.active ? paper.startingCapital : config.startingCapitalUsd);

  const manualClose = async (p: PaperPosition) => {
    try {
      const book = await fetchOrderBook(p.tokenId);
      const stats = bookStats(book);
      const sell = estimateSell(stats.bids, p.shares);
      const mark = markOf(p.tokenId, p.entryPrice);
      const exitPrice = sell.filledShares > 0 ? sell.avgPrice : mark;
      const proceeds = sell.filledShares > 0 ? sell.proceedsUsd : mark * p.shares;
      const exitFee = billing("SIGNAL", proceeds).feeUsd;
      desk.paperClose(p.id, exitPrice, proceeds, exitFee, "MANUAL");
    } catch {
      /* book unavailable — retry */
    }
  };

  const executeLive = async (d: DeskDecision) => {
    // silent-failure was the "execute does nothing" bug: every dead end now
    // tells the operator exactly what is blocking the order
    if (!isConnected) {
      notify({
        kind: "SYSTEM",
        title: "AI DESK — WALLET REQUIRED",
        body: "Connect a wallet to execute. Phantom works via its Polygon (EVM) side — Polymarket settles on Polygon.",
        href: "/ai",
      });
      return;
    }
    if (chainId !== polygon.id) {
      switchChain({ chainId: polygon.id });
      notify({
        kind: "SYSTEM",
        title: "AI DESK — WRONG NETWORK",
        body: "Polygon switch requested — approve it in your wallet, then hit EXECUTE again.",
        href: "/ai",
      });
      return;
    }
    let market = deskUniverse?.find((m) => m.slug === d.slug) ?? markets?.find((m) => m.slug === d.slug);
    if (!market) {
      try {
        market = (await fetchMarketBySlug(d.slug)) ?? undefined;
      } catch {
        /* market gone */
      }
    }
    if (!market) {
      notify({ kind: "SYSTEM", title: "AI DESK — MARKET UNAVAILABLE", body: d.question.slice(0, 80), href: "/ai" });
      return;
    }
    stage(market, d.outcomeIndex, "BUY", d.sizeUsd, "SIGNAL");
    desk.setDecisionStatus(d.id, "STAGED");
  };

  return (
    <div className="flex h-full">
      {/* configuration rail */}
      <div className="hairline-r w-[320px] shrink-0 overflow-y-auto">
        <div className="hairline-b flex h-11 items-center justify-between px-3">
          <span className="label">DESK CONFIGURATION</span>
          <Btn size="sm" variant="ghost" onClick={desk.resetDecisions} title="Clear decision feed">
            <RotateCcw size={10} strokeWidth={1.5} /> CLEAR
          </Btn>
        </div>
        <div className="flex flex-col gap-4 p-3">
          {/* execution mode */}
          <Field label="EXECUTION MODE">
            <div className="grid grid-cols-2 gap-px bg-line">
              {(["PAPER", "LIVE"] as ExecutionMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => desk.setConfig({ executionMode: m })}
                  className={cx(
                    "focus-outline flex h-9 items-center justify-center gap-1.5 text-[10px] font-medium tracking-[0.12em] transition-colors",
                    config.executionMode === m ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {m === "PAPER" && <FlaskConical size={11} strokeWidth={1.5} />}
                  {m}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-faint">
              {paperMode
                ? "FULLY AUTONOMOUS SIMULATION — FILLS COMPUTED AGAINST THE REAL ORDER BOOK, TIER FEES DEDUCTED, ZERO FUNDS AT RISK."
                : "REAL EXECUTION — IDENTICAL ENGINE; YOUR WALLET SIGNS EVERY ORDER."}
            </p>
          </Field>

          {!paperMode && isConnected && chainId !== polygon.id && (
            <button
              onClick={() => switchChain({ chainId: polygon.id })}
              className="focus-outline border border-warn/50 bg-warn/10 px-2.5 py-2 text-left text-[9.5px] uppercase leading-relaxed tracking-[0.08em] text-warn2 transition-colors hover:bg-warn/20"
            >
              WALLET ON WRONG NETWORK — TAP TO SWITCH TO POLYGON. PHANTOM: USE ITS POLYGON (EVM) SIDE; SOL ON SOLANA MUST BE BRIDGED/SWAPPED TO POLYGON USDC — POLYMARKET SETTLES ON POLYGON ONLY.
            </button>
          )}
          {!paperMode && !isConnected && (
            <div className="border border-line bg-raise px-2.5 py-2 text-[9.5px] uppercase leading-relaxed tracking-[0.08em] text-dim">
              NO WALLET CONNECTED — LIVE ORDERS NEED A POLYGON SIGNATURE. PHANTOM SUPPORTED VIA ITS POLYGON (EVM) SIDE.
            </div>
          )}
          {!paperMode && isConnected && chainId === polygon.id && (
            <div className="border border-line bg-raise px-2.5 py-2">
              <div className="label mb-1.5 text-[9px]">LIVE WALLET — POLYGON</div>
              <div className="mono-num grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
                <span className="text-faint">USDC.E (BANKROLL)</span>
                <span className={cx("text-right", (prov.usdcBalance ?? 0) >= 1 ? "text-pos2" : "text-neg2")}>
                  {prov.usdcBalance !== null ? fmt.usd(prov.usdcBalance, { compact: false }) : "—"}
                </span>
                <span className="text-faint">POL (GAS)</span>
                <span className={cx("text-right", prov.gasReady ? "text-pos2" : "text-neg2")}>
                  {prov.polBalance !== null ? prov.polBalance.toFixed(4) : "—"}
                </span>
                <span className="text-faint">SETTLEMENT</span>
                <span className={cx("text-right", prov.provisioned ? "text-pos2" : "text-warn2")}>
                  {prov.provisioned ? "PROVISIONED" : "NOT PROVISIONED"}
                </span>
              </div>
              {(prov.usdcBalance ?? 0) >= 1 && !prov.gasReady ? (
                <div className="mt-1.5">
                  <p className="text-[9px] leading-relaxed text-warn2">
                    COLLATERAL IS IN — ONLY POL GAS IS MISSING. BRIDGE ~$2 OF SOL → POL AND THE
                    APPROVALS UNLOCK AUTOMATICALLY (BALANCE POLLS EVERY 20S).
                  </p>
                  <a
                    href="https://jumper.exchange/?fromChain=1151111081099710&fromToken=11111111111111111111111111111111&toChain=137&toToken=0x0000000000000000000000000000000000000000"
                    target="_blank"
                    rel="noreferrer"
                    className="focus-outline mt-1.5 flex h-8 items-center justify-center border border-warn/50 bg-warn/10 text-[10px] font-medium uppercase tracking-[0.12em] text-warn2 transition-colors hover:bg-warn/20"
                  >
                    GET POL GAS — SOL → POL (PRE-FILLED)
                  </a>
                </div>
              ) : ((prov.usdcBalance ?? 0) < 1 || !prov.gasReady) ? (
                <p className="mt-1.5 text-[9px] leading-relaxed text-warn2">
                  DESK CANNOT DEPLOY — WALLET HOLDS NO POLYGON COLLATERAL/GAS. SOL ON THE SOLANA
                  NETWORK MUST BE BRIDGED TO POLYGON USDC + A LITTLE POL FIRST.
                </p>
              ) : null}
              <div className="mt-2 border border-accent/25 bg-accent/[0.04] px-2 py-1.5">
                <div className="label mb-1 text-[9px] text-accent2">TRADING WALLET — POLYMARKET V2 DEPOSIT</div>
                {depositWallet ? (
                  <>
                    <div className="mono-num flex items-center justify-between text-[9.5px] tabular-nums text-dim">
                      <span>{depositWallet.slice(0, 8)}…{depositWallet.slice(-6)}</span>
                      <span className={(tradingBal ?? 0) >= 1 ? "text-pos2" : "text-warn2"}>
                        {tradingBal !== null ? fmt.usd(tradingBal, { compact: false }) : "—"}
                      </span>
                    </div>
                    <p className="mt-1 text-[9px] leading-relaxed text-faint">
                      THIS IS POLYMARKET.COM'S OWN WALLET FOR YOUR ACCOUNT — DEPOSITS AND CASH ON
                      THE SITE LIVE HERE, AND SENTRY NOW TRADES FROM THE SAME PLACE.
                    </p>
                    {legacyBal > 0.5 && (
                      <div className="mt-1.5 border border-warn/40 bg-warn/5 px-2 py-1.5">
                        <p className="text-[9px] leading-relaxed text-warn2">
                          {fmt.usd(legacyBal, { compact: false })} IS STRANDED IN AN OLD SYSTEM WALLET
                          ({LEGACY_DEPOSIT_WALLET.slice(0, 8)}…) — INVISIBLE TO POLYMARKET.COM. PULL IT
                          BACK TO YOUR OWN WALLET, THEN DEPOSIT VIA THE SITE.
                        </p>
                        <button
                          onClick={recoverStranded}
                          disabled={recovering || !walletClient}
                          className="focus-outline mt-1 flex h-8 w-full items-center justify-center border border-warn/50 bg-warn/10 text-[10px] font-medium uppercase tracking-[0.1em] text-warn2 transition-colors hover:bg-warn/20 disabled:opacity-50"
                        >
                          {recovering ? "RECOVERING — SIGN IN WALLET…" : `RECOVER ${fmt.usd(legacyBal, { compact: false })} → MY WALLET`}
                        </button>
                      </div>
                    )}
                    {needsPusdConversion && (
                      <div className="mt-1.5 border border-warn/40 bg-warn/5 px-2 py-1.5">
                        <p className="text-[9px] leading-relaxed text-warn2">
                          {fmt.usd(twUsdcBal ?? 0, { compact: false })} SITS AS USDC.E — CLOB V2 SETTLES
                          ONLY IN pUSD. ORDERS WILL BOUNCE ("BALANCE: 0") UNTIL CONVERTED 1:1.
                        </p>
                        <a
                          href="https://polymarket.com"
                          target="_blank"
                          rel="noreferrer"
                          className="focus-outline mt-1 flex h-7 w-full items-center justify-center border border-warn/50 bg-warn/10 text-[9.5px] font-medium uppercase tracking-[0.1em] text-warn2 transition-colors hover:bg-warn/20"
                        >
                          CONVERT ON POLYMARKET.COM — SAME WALLET, "BALANCE MIGRATION"
                        </a>
                      </div>
                    )}
                    {(prov.usdcBalance ?? 0) >= 0.5 && (
                      <button
                        onClick={depositToTrading}
                        disabled={depositPending}
                        className="focus-outline mt-1.5 flex h-8 w-full items-center justify-center border border-accent/50 bg-accent/10 text-[10px] font-medium uppercase tracking-[0.1em] text-accent2 transition-colors hover:bg-accent/20 disabled:opacity-50"
                      >
                        {depositPending
                          ? "AWAITING WALLET…"
                          : `DEPOSIT ${fmt.usd(prov.usdcBalance ?? 0, { compact: false })} → TRADING WALLET`}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-[9px] leading-relaxed text-faint">
                      CLOB V2 EXECUTES FROM YOUR POLYMARKET DEPOSIT WALLET, NOT THE EOA. THE WALLET
                      MUST BE DEPLOYED BY POLYMARKET'S OWN DEPOSIT FLOW FIRST — THIRD-PARTY RELAYER
                      KEYS CANNOT DEPLOY IT (VERIFIED: RELAYER REJECTS NON-BOUND ADDRESSES).
                    </p>
                    <a
                      href="https://polymarket.com"
                      target="_blank"
                      rel="noreferrer"
                      className="focus-outline mt-1.5 flex h-8 w-full items-center justify-center border border-warn/50 bg-warn/10 text-[10px] font-medium uppercase tracking-[0.1em] text-warn2 transition-colors hover:bg-warn/20"
                    >
                      STEP 1 — POLYMARKET.COM: LOG IN WITH THIS WALLET + DEPOSIT
                    </a>
                    <button
                      onClick={linkTradingWallet}
                      disabled={linking || !walletClient}
                      className="focus-outline mt-1.5 flex h-8 w-full items-center justify-center border border-accent/50 bg-accent/10 text-[10px] font-medium uppercase tracking-[0.1em] text-accent2 transition-colors hover:bg-accent/20 disabled:opacity-50"
                    >
                      {linking ? "LINKING…" : "STEP 2 — LINK TRADING WALLET (1 SIGNATURE)"}
                    </button>
                  </>
                )}
              </div>
              <div className="mt-2">
                <NumField
                  label="DESK BUDGET $ — MAX THE DESK MAY DEPLOY"
                  value={config.budgetUsd}
                  onChange={(v) => desk.setConfig({ budgetUsd: v })}
                />
                <p className="mt-1 text-[9px] leading-relaxed text-faint">
                  BANKROLL = MIN(WALLET USDC.E, BUDGET). SET IT, SWITCH STAGING TO ARM, AND THE DESK
                  RUNS TO TARGET BY ITSELF — YOUR WALLET POPS UP ONLY TO SIGN EACH ORDER.
                </p>
              </div>
              <Link
                to="/treasury"
                className="focus-outline mt-2 flex h-8 items-center justify-center border border-accent/50 bg-accent/10 text-[10px] font-medium uppercase tracking-[0.12em] text-accent2 transition-colors hover:bg-accent/20"
              >
                FUND / WITHDRAW — TREASURY
              </Link>
            </div>
          )}

          <Field label="TEMPO — SPEED OF CAPITAL">
            <div className="grid grid-cols-3 gap-px bg-line">
              {(["SCALP", "INTRADAY", "SWING"] as Tempo[]).map((t) => (
                <button
                  key={t}
                  onClick={() => desk.setTempo(t)}
                  className={cx(
                    "focus-outline h-8 text-[8.5px] font-medium tracking-[0.08em] transition-colors",
                    config.tempo === t ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-faint">
              {config.tempo === "SCALP"
                ? "CHURN — ≤3D MARKETS, 4% TAKE-PROFIT / 5% STOP, ≤15M HOLD, 8 ENTRIES/CYCLE, 6S SWEEP, UP TO 30 CONCURRENT."
                : config.tempo === "INTRADAY"
                  ? "≤10D MARKETS, 12% TP, ≤4H HOLD, 3 ENTRIES/CYCLE, 20S SWEEP, UP TO 10 CONCURRENT."
                  : "≤45D MARKETS, 20% TP, ≤24H HOLD, 2 ENTRIES/CYCLE, 45S SWEEP, UP TO 6 CONCURRENT."}
            </p>
          </Field>

          {/* engage / paper session controls */}
          {paperMode ? (
            !paper.active ? (
              <div className="flex flex-col gap-2">
                <NumField
                  label="STARTING CAPITAL $ (VIRTUAL)"
                  value={config.startingCapitalUsd}
                  onChange={(v) => desk.setConfig({ startingCapitalUsd: v })}
                />
                <button
                  onClick={desk.startPaperSession}
                  className="focus-outline flex h-11 items-center justify-center gap-2 border border-accent/70 bg-accent/15 text-[12px] font-semibold uppercase tracking-[0.16em] text-accent2 transition-colors hover:bg-accent/25"
                >
                  <Power size={13} strokeWidth={1.5} /> START PAPER SESSION
                </button>
              </div>
            ) : (
              <button
                onClick={desk.stopPaperSession}
                className="focus-outline flex h-11 items-center justify-center gap-2 border border-pos/60 bg-pos/15 text-[11px] font-semibold uppercase tracking-[0.14em] text-pos2"
              >
                <Power size={13} strokeWidth={1.5} /> SESSION LIVE — CLICK TO STAND DOWN
              </button>
            )
          ) : (
            <>
              <button
                onClick={() => desk.setEngaged(!engaged)}
                className={cx(
                  "focus-outline flex h-11 items-center justify-center gap-2 border text-[12px] font-semibold uppercase tracking-[0.18em] transition-colors",
                  engaged
                    ? "border-pos/60 bg-pos/15 text-pos2"
                    : "border-accent/60 bg-accent/10 text-accent2 hover:bg-accent/20",
                )}
              >
                <Power size={13} strokeWidth={1.5} />
                {engaged ? "DESK ENGAGED — CLICK TO STAND DOWN" : "ENGAGE DESK"}
              </button>
              <Field label="LIVE STAGING MODE">
                <div className="grid grid-cols-2 gap-px bg-line">
                  {(["ADVISE", "ARM"] as DeskMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => desk.setConfig({ mode: m })}
                      className={cx(
                        "focus-outline h-8 text-[10px] font-medium tracking-[0.1em] transition-colors",
                        config.mode === m ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}

          {haltReason && (
            <div className="border border-warn/40 bg-warn/5 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.08em] text-warn2">
              {haltReason}
            </div>
          )}

          <Field label="CONTROL MODE">
            <div className="grid grid-cols-2 gap-px bg-line">
              {([true, false] as const).map((fw) => (
                <button
                  key={String(fw)}
                  onClick={() => desk.setConfig({ freeWill: fw })}
                  className={cx(
                    "focus-outline h-8 text-[9.5px] font-medium tracking-[0.1em] transition-colors",
                    config.freeWill === fw ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {fw ? "FREE WILL" : "MANUAL"}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-faint">
              {config.freeWill
                ? "YOU SET CAPITAL AND TARGET — THE DESK DERIVES SIZING, EXPOSURE AND EXITS FROM THE LIVE BANKROLL AND CLIPS EVERY ORDER TO ORDER-BOOK DEPTH."
                : "ALL SIZING AND RISK PARAMETERS UNDER MANUAL CONTROL."}
            </p>
          </Field>

          {config.freeWill ? (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <NumField label="TARGET PROFIT $" value={config.targetProfitUsd} onChange={(v) => desk.setConfig({ targetProfitUsd: v })} />
                <div className="flex flex-col gap-1">
                  <span className="label text-[9px]">LOSS BRAKE $ (10% BANK)</span>
                  <div className="flex h-8 items-center border border-line bg-raise2 px-2 font-mono text-[11px] tabular-nums text-dim">
                    {eff.maxLossUsd}
                  </div>
                </div>
              </div>
              <div className="border border-accent/25 bg-accent/[0.04] px-2.5 py-2">
                <div className="label mb-1.5 text-[9px] text-accent2">
                  DERIVED ENVELOPE — TRACKS BANKROLL ${fwBase.toFixed(0)}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-dim">
                  <span className="text-faint">CLIP SIZE</span>
                  <span className="text-right">${eff.minTradeUsd}–${eff.maxTradeUsd}</span>
                  <span className="text-faint">MAX POSITIONS</span>
                  <span className="text-right">{eff.maxPositions}</span>
                  <span className="text-faint">MAX HOLD</span>
                  <span className="text-right">{eff.maxHoldMin} MIN</span>
                  <span className="text-faint">TP / SL</span>
                  <span className="text-right">+{eff.takeProfitPct}% / −{eff.stopLossPct}%</span>
                  <span className="text-faint">DEPTH CLIP</span>
                  <span className="text-right">≤½ BOOK @ +1%</span>
                </div>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <NumField label="TARGET PROFIT $" value={config.targetProfitUsd} onChange={(v) => desk.setConfig({ targetProfitUsd: v })} />
              <NumField label="MAX LOSS $" value={config.maxLossUsd} onChange={(v) => desk.setConfig({ maxLossUsd: v })} />
              <NumField label="MIN TRADE $" value={config.minTradeUsd} onChange={(v) => desk.setConfig({ minTradeUsd: v })} />
              <NumField label="MAX TRADE $" value={config.maxTradeUsd} onChange={(v) => desk.setConfig({ maxTradeUsd: v })} />
              <NumField label="MAX POSITIONS" value={config.maxPositions} onChange={(v) => desk.setConfig({ maxPositions: v })} />
              <NumField label="MAX HOLD (MIN)" value={config.maxHoldMin} onChange={(v) => desk.setConfig({ maxHoldMin: v })} />
              <NumField label="TAKE PROFIT %" value={config.takeProfitPct} onChange={(v) => desk.setConfig({ takeProfitPct: v })} />
              <NumField label="STOP LOSS %" value={config.stopLossPct} onChange={(v) => desk.setConfig({ stopLossPct: v })} />
            </div>
          )}

          <Field label="RISK PROFILE">
            <div className="grid grid-cols-3 gap-px bg-line">
              {(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as RiskProfile[]).map((r) => (
                <button
                  key={r}
                  onClick={() => desk.setConfig({ risk: r })}
                  className={cx(
                    "focus-outline h-8 text-[8.5px] font-medium tracking-[0.06em] transition-colors",
                    config.risk === r ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </Field>

          <Field label={`SELECTIVITY — TOP ${(100 - config.minConfidence * 10).toFixed(0)}% OF SWEEP (${config.minConfidence.toFixed(1)}/10)`}>
            <input
              type="range"
              min={3}
              max={9}
              step={0.5}
              value={config.minConfidence}
              onChange={(e) => desk.setConfig({ minConfidence: Number(e.target.value) })}
              className="w-full accent-[var(--sv-accent)]"
            />
          </Field>

          <Field label="DOMAINS — EMPTY = ALL">
            <div className="flex flex-wrap gap-1">
              {DOMAINS.map((d) => {
                const on = config.domains.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() =>
                      desk.setConfig({
                        domains: on ? config.domains.filter((x) => x !== d) : [...config.domains, d],
                      })
                    }
                    className={cx(
                      "focus-outline h-6 border px-2 text-[9px] uppercase tracking-[0.08em] transition-colors",
                      on ? "border-accent/60 bg-accent/10 text-accent2" : "border-line text-faint hover:text-dim",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="CLAUDE OVERLAY — OPTIONAL">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={config.claudeEnabled}
                onChange={(e) => desk.setConfig({ claudeEnabled: e.target.checked })}
                className="size-3 appearance-none border border-line-strong bg-raise2 checked:border-accent checked:bg-accent/40"
              />
              <span className="label">AI RISK OFFICER REVIEWS PROPOSALS</span>
            </label>
            {config.claudeEnabled && (
              <div className="mt-2 flex flex-col gap-1.5">
                <input
                  type="password"
                  value={config.anthropicKey}
                  onChange={(e) => desk.setConfig({ anthropicKey: e.target.value.trim() })}
                  placeholder="ANTHROPIC API KEY (sk-ant-…)"
                  className="focus-outline mono-num h-8 w-full border border-line bg-raise2 px-2 text-[10px] text-text placeholder:text-faint"
                />
                <select
                  value={config.anthropicModel}
                  onChange={(e) => desk.setConfig({ anthropicModel: e.target.value })}
                  className="focus-outline mono-num h-8 w-full border border-line bg-raise2 px-2 text-[10px] text-text"
                >
                  <option value="claude-opus-4-8">claude-opus-4-8 — deepest reasoning</option>
                  <option value="claude-sonnet-5">claude-sonnet-5 — balanced</option>
                  <option value="claude-haiku-4-5">claude-haiku-4-5 — fastest</option>
                </select>
                <p className="text-[9px] leading-relaxed text-faint">
                  KEY STAYS IN THIS BROWSER; CALLS GO DIRECTLY TO API.ANTHROPIC.COM. VETOED
                  PROPOSALS NEVER FILL.
                </p>
              </div>
            )}
          </Field>

          <div className="hairline-t pt-2">
            <span className="label-faint">
              EXECUTIONS BILL AT THE SIGNAL RATE — {bpsPct(signalRate)} (SIMULATED IN PAPER) ·
              LIVE MODE IS NON-CUSTODIAL: EVERY ORDER IS WALLET-SIGNED
            </span>
          </div>
        </div>
      </div>

      {/* operations theater */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="hairline-b px-4 py-3">
          <div className="mb-3 flex items-baseline justify-between">
            <h1 className="flex items-center gap-2 text-[13px] font-semibold tracking-[0.16em] text-text">
              AI OPERATIONS
              {paperMode && <Tag tone="accent">PAPER — NO FUNDS AT RISK</Tag>}
            </h1>
            <span className={cx("label-faint flex items-center gap-1.5", (engaged || paper.active) && "text-pos")}>
              <span className={cx("size-1.5", engaged || paper.active ? "animate-blip bg-pos" : "bg-faint")} />
              {paper.active
                ? "SESSION LIVE — AUTONOMOUS ENTRIES + EXITS AGAINST THE REAL BOOK"
                : engaged
                  ? "ENGINE LIVE — RESCORING WITH EACH DATA CYCLE"
                  : "ENGINE STANDBY"}
            </span>
          </div>

          {paperMode ? (
            <div className="grid grid-cols-6 gap-6">
              <Metric
                label="VIRTUAL EQUITY"
                value={fmt.usd(equity, { compact: false })}
                sub={`started ${fmt.usd(paper.startingCapital, { compact: false })}`}
                tone={sessionPnl >= 0 ? "pos" : "neg"}
              />
              <Metric label="CASH / DEPLOYED" value={`${fmt.usd(paper.cash)} / ${fmt.usd(equity - paper.cash)}`} sub={`${paper.positions.length}/${config.maxPositions} positions open`} />
              <Metric label="REALIZED P&L" value={fmt.usd(realized, { sign: true, compact: false })} tone={realized >= 0 ? "pos" : "neg"} sub={`${paper.closed.length} trades · ${paper.closed.length ? Math.round((wins / paper.closed.length) * 100) : 0}% win`} />
              <Metric label="UNREALIZED" value={fmt.usd(unrealized, { sign: true, compact: false })} tone={unrealized >= 0 ? "pos" : "neg"} sub="live marks" />
              <Metric label="FEES PAID (SIM)" value={fmt.usd(paper.feesPaid, { compact: false })} sub={`at ${bpsPct(signalRate)} signal rate`} />
              <div className="flex flex-col gap-1">
                <div className="label-faint">TARGET — {fmt.usd(config.targetProfitUsd)}</div>
                <div className={cx("mono-num text-[17px] leading-none", sessionPnl >= 0 ? "text-pos" : "text-neg")}>
                  {fmt.usd(sessionPnl, { sign: true, compact: false })}
                </div>
                <div className="h-[3px] w-full bg-raise3">
                  <div className="h-full bg-pos/70" style={{ width: `${targetProgress * 100}%` }} />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-6">
              <Metric label="LIVE EXECUTIONS" value={desk.liveExecuted.length} />
              <Metric label="MAX POSITIONS" value={config.maxPositions} />
              <Metric label="STAGING" value={config.mode} sub="ARM auto-stages; wallet signs" />
              <Metric label="PROPOSALS PENDING" value={decisions.filter((d) => d.status === "PROPOSED").length} tone="accent" />
            </div>
          )}
          {(engaged || paper.active) && scan.scannedAt > 0 && (
            <div className="mono-num mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border border-line bg-raise2 px-3 py-1.5 text-[9.5px] uppercase tracking-[0.08em]">
              <span className="text-faint">STATISTICAL SWEEP</span>
              <span className="text-dim">UNIVERSE <span className="text-text">{scan.universe.toLocaleString()}</span></span>
              <span className="text-dim">PASSED FILTERS <span className="text-text">{scan.filtered}</span></span>
              <span className="text-dim">QUALIFIERS <span className="text-text">{scan.qualifiers}</span></span>
              <span className="text-dim">EV-POSITIVE <span className="text-pos">{scan.evPositive}</span></span>
              <span className="text-dim">PLANNED ENTRIES THIS CYCLE <span className="text-accent2">{scan.plannedThisCycle}</span></span>
              {scan.avgHoldMin > 0 && <span className="text-dim">AVG EXPECTED HOLD <span className="text-text">~{Math.round(scan.avgHoldMin)}M</span></span>}
              <span className="text-dim">DEPLOY LADDER <span className="text-warn2">{(capFrac * 100).toFixed(0)}% OF BANK</span></span>
              <span className="text-dim">LIVE SPOT FEED <span className={liveRefOk ? "text-pos" : "text-faint"}>{liveRefOk ? "CONNECTED" : "OFFLINE"}</span></span>
              <span className="text-dim">
                ELITE FLOW <span className={scan.smart > 0 ? "text-pos" : "text-faint"}>{scan.smart}</span>
                {eliteOps.length > 0 && (
                  <span className="text-faint">
                    {" "}· TRACKING {eliteOps.length} OPS · TOP WIN {Math.round(eliteOps[0].winRate * 100)}%
                  </span>
                )}
              </span>
              <span className="ml-auto text-faint">{fmt.timeAgo(Math.floor(scan.scannedAt / 1000))} AGO</span>
            </div>
          )}
          {aiStatus && <div className="mono-num mt-2 text-[9.5px] uppercase tracking-[0.08em] text-accent2">{aiStatus}</div>}
        </div>

        <div className="grid grid-cols-3 gap-px bg-line p-px">
          {/* open positions (paper) */}
          {paperMode && (
            <Panel className="col-span-3 border-0" title="OPEN POSITIONS — LIVE MARKS" pad={false}>
              {!paper.positions.length ? (
                <Empty
                  label={paper.active ? "SCANNING FOR ENTRIES" : "NO OPEN POSITIONS"}
                  hint={paper.active ? "The desk auto-fills the best qualifying proposal each cycle." : "Start a paper session to begin."}
                />
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="hairline-b">
                      <th className="label-faint px-3 py-1.5 text-left font-medium">MARKET</th>
                      <th className="label-faint px-2 py-1.5 text-left font-medium">SIDE</th>
                      <th className="label-faint px-2 py-1.5 text-right font-medium">ENTRY → MARK</th>
                      <th className="label-faint px-2 py-1.5 text-right font-medium">TP / SL</th>
                      <th className="label-faint px-2 py-1.5 text-right font-medium">SIZE</th>
                      <th className="label-faint px-2 py-1.5 text-right font-medium">P&L (LIVE)</th>
                      <th className="label-faint px-2 py-1.5 text-right font-medium">AGE</th>
                      <th className="w-20 px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {paper.positions.map((p) => {
                      const mark = markOf(p.tokenId, p.entryPrice);
                      const pnl = (mark - p.entryPrice) * p.shares;
                      return (
                        <tr key={p.id} className="hairline-b h-10 row-hover">
                          <td className="max-w-0 truncate px-3 text-[11.5px] text-text">
                            <button onClick={() => navigate(`/market/${p.slug}`)} className="hover:text-accent2">{p.question}</button>
                          </td>
                          <td className="px-2 text-[10px] font-semibold text-pos">{p.outcome.toUpperCase()}</td>
                          <td className="mono-num px-2 text-right text-[10.5px] text-dim">
                            {(p.entryPrice * 100).toFixed(1)}¢ → {(mark * 100).toFixed(1)}¢
                          </td>
                          <td className="mono-num px-2 text-right text-[10px] text-faint">
                            {(p.tpPrice * 100).toFixed(0)} / {(p.slPrice * 100).toFixed(0)}
                          </td>
                          <td className="mono-num px-2 text-right text-[11px] text-text">{fmt.usd(p.costUsd)}</td>
                          <td className={cx("mono-num px-2 text-right text-[11px]", pnl >= 0 ? "text-pos" : "text-neg")}>
                            {fmt.usd(pnl, { sign: true, compact: false })}
                          </td>
                          <td className="mono-num px-2 text-right text-[10px] text-faint">{fmt.timeAgo(p.ts)}</td>
                          <td className="px-2 text-right">
                            <Btn size="sm" variant="ghost" onClick={() => void manualClose(p)}>CLOSE</Btn>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Panel>
          )}

          {/* decision feed */}
          <Panel className="col-span-2 border-0" title="DECISION FEED — SCORED PROPOSALS" pad={false}>
            {decisions.length === 0 ? (
              <Empty
                label={engaged || paper.active ? "NO QUALIFIERS THIS CYCLE" : "ENGINE STANDBY"}
                hint={engaged || paper.active ? "No market clears the confidence floor under the current risk profile." : "Start a session to begin scoring the live universe."}
              />
            ) : (
              <div className="flex max-h-[520px] flex-col overflow-y-auto">
                {decisions.map((d) => (
                  <div key={d.id} className={cx("hairline-b px-4 py-3", d.status === "VETOED" && "opacity-45")}>
                    <div className="flex items-center gap-2">
                      <span className="mono-num text-[9px] text-faint">{d.id}</span>
                      <Tag
                        tone={
                          d.status === "FILLED" || d.status === "EXECUTED"
                            ? "pos"
                            : d.status === "STAGED"
                              ? "accent"
                              : d.status === "VETOED"
                                ? "neg"
                                : "dim"
                        }
                      >
                        {d.status === "PROPOSED" && paperMode && paper.active ? "QUEUED — AUTO-FILL" : d.status}
                      </Tag>
                      {d.aiVerdict === "GO" && <Tag tone="pos">AI GO</Tag>}
                      {d.aiVerdict === "VETO" && <Tag tone="neg">AI VETO</Tag>}
                      <span className="mono-num ml-auto text-[9px] text-faint">{fmt.timeAgo(d.ts)} AGO</span>
                    </div>
                    <button
                      onClick={() => navigate(`/market/${d.slug}`)}
                      className="mt-1.5 block text-left text-[12.5px] text-text hover:text-accent2"
                    >
                      {d.question}
                    </button>
                    <div className="mono-num mt-1 flex items-center gap-4 text-[10.5px]">
                      <span className="text-pos2">BUY {d.outcome.toUpperCase()} @ {(d.price * 100).toFixed(1)}¢</span>
                      <span className="text-text">{fmt.usd(d.sizeUsd)}</span>
                      <span className="flex items-center gap-1.5 text-dim">
                        SCORE
                        <span className="inline-block h-[3px] w-16 bg-raise3">
                          <span className="block h-full bg-accent/80" style={{ width: `${d.score * 10}%` }} />
                        </span>
                        {d.score.toFixed(1)}
                      </span>
                      <span className="text-faint">CONF {d.confidence.toFixed(1)}/10</span>
                    </div>
                    <div className="mono-num mt-1 flex items-center gap-4 text-[10px]">
                      <span className={cx(d.evCents > 0 ? "text-pos" : "text-neg")}>
                        EV {d.evCents >= 0 ? "+" : ""}{d.evCents.toFixed(2)}¢/SH NET
                      </span>
                      <span className="text-dim">P(WIN) {(d.pWin * 100).toFixed(0)}%</span>
                      <span className="text-dim">HOLD ~{Math.round(d.expHoldMin)}M</span>
                      <span className={cx(d.evPerHourUsd > 0 ? "text-accent2" : "text-faint")}>
                        {d.evPerHourUsd >= 0 ? "+" : ""}${d.evPerHourUsd.toFixed(1)}/HR
                      </span>
                      <span className="text-faint">α {d.alpha.toFixed(2)}σ</span>
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {d.reasons.slice(0, 4).map((r) => (
                        <li key={r} className="text-[10px] leading-snug text-dim">— {r}</li>
                      ))}
                      {d.aiNote && (
                        <li className={cx("text-[10px] leading-snug", d.aiVerdict === "VETO" ? "text-neg2" : "text-accent2")}>
                          AI — {d.aiNote}
                        </li>
                      )}
                    </ul>
                    {d.status === "PROPOSED" && !paperMode && (
                      <div className="mt-2 flex gap-1.5">
                        <Btn size="sm" variant="yes" onClick={() => executeLive(d)}>
                          EXECUTE · {fmt.usd(d.sizeUsd)}
                        </Btn>
                        <Btn size="sm" variant="ghost" onClick={() => desk.setDecisionStatus(d.id, "SKIPPED")}>
                          SKIP
                        </Btn>
                      </div>
                    )}
                    {d.status === "PROPOSED" && paperMode && (
                      <div className="mt-2">
                        <Btn size="sm" variant="ghost" onClick={() => desk.setDecisionStatus(d.id, "SKIPPED")}>
                          EXCLUDE FROM AUTO-FILL
                        </Btn>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* session ledger */}
          <Panel className="border-0" title={paperMode ? "SESSION LEDGER — CLOSED TRADES" : "LIVE EXECUTION LOG"} pad={false}>
            {paperMode ? (
              !paper.closed.length ? (
                <Empty label="NO CLOSED TRADES" hint="Exits fire on take-profit, stop-loss or time." />
              ) : (
                <div className="flex max-h-[520px] flex-col overflow-y-auto">
                  {paper.closed.map((t) => (
                    <div key={t.id} className="hairline-b px-3 py-2.5">
                      <div className="line-clamp-1 text-[11px] text-text">{t.question}</div>
                      <div className="mono-num mt-1 flex items-center gap-2.5 text-[10px]">
                        <Tag
                          tone={t.reason === "TAKE_PROFIT" ? "pos" : t.reason === "STOP_LOSS" ? "neg" : "dim"}
                        >
                          {t.reason.replaceAll("_", " ")}
                        </Tag>
                        <span className="text-faint">
                          {(t.entryPrice * 100).toFixed(1)}¢ → {(t.exitPrice * 100).toFixed(1)}¢
                        </span>
                        <span className={cx("ml-auto text-[11px]", t.pnl >= 0 ? "text-pos" : "text-neg")}>
                          {fmt.usd(t.pnl, { sign: true, compact: false })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : !desk.liveExecuted.length ? (
              <Empty label="NO LIVE EXECUTIONS" hint="Confirmed desk orders appear here." />
            ) : (
              <div className="flex max-h-[520px] flex-col overflow-y-auto">
                {desk.liveExecuted.map((e) => {
                  const mark = markOf(e.tokenId, e.entryPrice);
                  const pnl = (mark - e.entryPrice) * e.shares;
                  return (
                    <Link key={e.decisionId + e.ts} to={`/market/${e.slug}`} className="hairline-b row-hover block px-3 py-2.5">
                      <div className="line-clamp-1 text-[11px] text-text">{e.question}</div>
                      <div className="mono-num mt-1 flex items-center gap-3 text-[10px]">
                        <span className="text-dim">{e.outcome.toUpperCase()}</span>
                        <span className="text-faint">{(e.entryPrice * 100).toFixed(1)}¢ → {(mark * 100).toFixed(1)}¢</span>
                        <span className="text-text">{fmt.usd(e.usd)}</span>
                        <span className={cx("ml-auto", pnl >= 0 ? "text-pos" : "text-neg")}>{fmt.usd(pnl, { sign: true, compact: false })}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label-faint mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="label-faint mb-1">{label}</div>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        className="focus-outline mono-num h-8 w-full border border-line bg-raise2 px-2 text-[12px] text-text"
      />
    </div>
  );
}
