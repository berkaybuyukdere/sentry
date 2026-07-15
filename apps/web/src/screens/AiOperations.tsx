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
import { signAndPlaceOrder, snapToTick } from "../lib/trading/orders";
import { useSessionSigner, sessionAddress, sessionWalletClient } from "../lib/trading/sessionSigner";
import { readCtfShareBalance } from "../lib/trading/ctfBalance";
import { sendLiveMail } from "../lib/liveMail";
import { USDC, PUSD, LEGACY_DEPOSIT_WALLET, POLY_PROXY_WALLET } from "../lib/trading/constants";
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
  type LiveExecution,
  type Tempo,
} from "../lib/aiDesk";
import { Panel, Btn, Tag, Metric, Empty, LiveNum, cx } from "../components/ui/primitives";

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
  const { config, engaged, haltReason, decisions, paper, aiStatus, liveAutoStatus, scan } = desk;
  const { data: markets } = useMarkets({ limit: 400 }, 45_000);
  const { data: deskUniverse } = useDeskUniverse(25_000);
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const notify = useNotifications((s) => s.push);
  const eliteOps = useSmartFlow((s) => s.elite);
  const prov = useProvision();
  const { data: phantomWalletClient } = useWalletClient();
  const { writeContract: depositWrite, isPending: depositPending } = useWriteContract();
  const [linking, setLinking] = useState(false);
  // AUTOPILOT: with the session signer armed, the desk's whole trading
  // identity (signing key + proxy wallet + balances) is the session account —
  // Phantom stays connected only as the treasury, never prompted per order
  const sess = useSessionSigner();
  const autoSign = sess.enabled && !!sess.pk && !!sess.proxyWallet;
  // CLOB v2 executes from the Polymarket Deposit Wallet, not the EOA
  const { address: phantomAddress } = useAccount();
  const address = autoSign ? sessionAddress() : phantomAddress;
  const walletClient = autoSign ? sessionWalletClient() : phantomWalletClient;
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
    query: { enabled: !!depositWallet, refetchInterval: 10_000 },
  });
  const twUsdcBal = twReads.data ? Number((twReads.data[0]?.result as bigint | undefined) ?? 0n) / 1e6 : null;
  const twPusdBal = twReads.data ? Number((twReads.data[1]?.result as bigint | undefined) ?? 0n) / 1e6 : null;
  const tradingBal = twReads.data ? (twUsdcBal ?? 0) + (twPusdBal ?? 0) : null;
  const legacyUnits = (twReads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const legacyBal = twReads.data ? Number(legacyUnits) / 1e6 : 0;
  const [recovering, setRecovering] = useState(false);

  const recoverStranded = async () => {
    // legacy recovery is a MAIN-account operation — always Phantom, even
    // with autopilot armed (the stranded funds belong to the main EOA)
    if (!phantomWalletClient || !phantomAddress || legacyUnits === 0n) return;
    setRecovering(true);
    console.info("%c[SENTRY] recovering stranded funds from legacy deposit wallet…", "color:#59f");
    try {
      const txHash = await recoverLegacyFunds(phantomWalletClient, phantomAddress, legacyUnits);
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

  // LIVE mode — same KPI shape as PAPER, computed from real fills/marks.
  // KPI sums cover only the CURRENT identity's positions: wallet equity and
  // baseline are per-wallet, so mixing the other account's cost/marks into
  // them reports a fictitious P&L (the table below still lists everything).
  const accrue = useBilling((s) => s.accrue);
  const kpiOwned = (e: LiveExecution): boolean => {
    const owner = e.owner ?? phantomAddress?.toLowerCase();
    return !!address && owner === address.toLowerCase();
  };
  // with autopilot armed, "connected"/"chainId" below still describe PHANTOM
  // specifically (the session signer is an in-memory key, not a wagmi
  // connector) — any position NOT owned by the active identity still needs
  // Phantom itself connected + on Polygon for its own exits to sign. Hiding
  // the network/connect banners just because autopilot is armed was leaving
  // those positions unprotected with no visible warning.
  const hasOtherWalletPositions = desk.liveExecuted.some((e) => !kpiOwned(e));
  const liveDeployed = desk.liveExecuted.filter(kpiOwned).reduce((s, e) => s + e.costUsd, 0);
  const liveUnrealized = desk.liveExecuted.filter(kpiOwned).reduce(
    (s, e) => s + (markOf(e.tokenId, e.entryPrice) - e.entryPrice) * e.shares,
    0,
  );
  const liveRealized = desk.liveClosed.reduce((s, t) => s + t.pnl, 0);
  const liveWins = desk.liveClosed.filter((t) => t.pnl > 0).length;
  const liveFeesPaid =
    desk.liveExecuted.reduce((s, e) => s + e.feeUsd, 0) +
    desk.liveClosed.reduce((s, t) => s + t.feeUsd + t.exitFee, 0);
  const liveEquity = (tradingBal ?? 0) + liveDeployed + liveUnrealized;
  const liveSessionPnl = desk.liveBaseline !== null ? liveEquity - desk.liveBaseline : liveRealized + liveUnrealized;
  const liveTargetProgress = Math.min(Math.max(liveSessionPnl / Math.max(config.targetProfitUsd, 1), 0), 1);
  // live-derived envelope shown when FREE WILL is on — same math the engine
  // runs; in LIVE mode the bankroll is the wallet's real Polygon USDC.e
  const fwBase = paperMode
    ? (paper.active ? equity : config.startingCapitalUsd)
    : config.budgetAuto
      ? ((depositWallet ? tradingBal : prov.usdcBalance) ?? 0)
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

  const [closingLive, setClosingLive] = useState<string | null>(null);
  const manualCloseLive = async (p: LiveExecution) => {
    // the SELL must sign with the identity that OPENED the position — its
    // proxy holds the shares (pre-autopilot records belong to Phantom)
    const owner = p.owner ?? phantomAddress?.toLowerCase();
    const sessAddr = sess.pk ? sessionAddress() : null;
    const useSession = !!sessAddr && !!sess.proxyWallet && owner === sessAddr.toLowerCase();
    const wClient = useSession ? sessionWalletClient() : phantomWalletClient;
    const wAddr = useSession ? sessAddr : phantomAddress;
    if (!wClient || !wAddr || (owner && wAddr.toLowerCase() !== owner)) {
      notify({ kind: "SYSTEM", title: "CLOSE BLOCKED — OWNER WALLET UNAVAILABLE", body: `This position was opened by ${owner?.slice(0, 10)}… — connect that wallet (or re-arm its autopilot key) to close it.`, href: "/ai" });
      return;
    }
    setClosingLive(p.decisionId);
    try {
      // ground-truth reconciliation before attempting to sell — see the full
      // story in aiDesk.ts's exit tick. Deliberately LESS aggressive here: a
      // single click gets a single RPC read, so this path only ever RESIZES
      // (never deletes) — write-offs need the tick's 2-consecutive-read
      // confirmation, since a lone stale read must never erase real money on
      // one click. A just-opened position (<15s) skips the check entirely —
      // its on-chain transfer may simply not be mined yet.
      let shares = p.shares;
      if (Math.floor(Date.now() / 1000) - p.ts >= 15) {
        const makerWallet = cachedDepositWallet(wAddr);
        let onChainShares: number | null = null;
        if (makerWallet) {
          try {
            onChainShares = await readCtfShareBalance(makerWallet, p.tokenId);
          } catch {
            /* RPC hiccup — proceed on the ledgered value */
          }
        }
        if (onChainShares !== null) {
          const siblingShares = desk.liveExecuted
            .filter((e) => e.decisionId !== p.decisionId && e.tokenId === p.tokenId && (e.owner ?? phantomAddress?.toLowerCase()) === owner)
            .reduce((s, e) => s + e.shares, 0);
          const allocatable = Math.max(0, onChainShares - siblingShares);
          if (allocatable < 0.01) {
            notify({ kind: "SYSTEM", title: "CLOSE HELD — BALANCE READS 0 ON-CHAIN", body: "This may be a very recent fill still settling, or a stale ledger entry. The automatic exit engine double-checks and self-heals; try again shortly.", href: "/ai" });
            return;
          }
          if (allocatable < p.shares - 0.01) {
            const factor = allocatable / p.shares;
            desk.rebaseLivePosition(p.decisionId, { shares: allocatable, costUsd: p.costUsd * factor, feeUsd: p.feeUsd * factor, usd: p.usd * factor });
            shares = allocatable;
            notify({ kind: "SYSTEM", title: "POSITION SIZE RECONCILED — RETRY CLOSE", body: `Ledger said ${p.shares.toFixed(2)} sh, wallet allocates ${allocatable.toFixed(2)}. Corrected — hit CLOSE again.`, href: "/ai" });
            return;
          }
        }
      }
      const book = await fetchOrderBook(p.tokenId);
      const stats = bookStats(book);
      // price the FAK off bids NEAR THE TOP of the book: estimateSell walks
      // the whole stack, so a penny-bid wall would set its own acceptance
      // price and the close would dump the position for ~nothing
      if (stats.bestBid === null) {
        notify({ kind: "SYSTEM", title: "CLOSE BLOCKED — NO BIDS", body: "The book has no buyers right now; there is nothing to sell into. Try again when liquidity returns.", href: "/ai" });
        return;
      }
      const bidFloor = Math.max(p.tickSize, stats.bestBid * 0.9);
      const sellPreview = estimateSell(stats.bids.filter((b) => b.price >= bidFloor), shares);
      const sellShares = Math.floor(sellPreview.filledShares * 100) / 100;
      if (sellShares < 0.01) {
        notify({ kind: "SYSTEM", title: "CLOSE BLOCKED — NO REAL DEPTH", body: "No buyers near the top of the book; selling now would dump into junk bids. Try again when liquidity returns.", href: "/ai" });
        return;
      }
      if (sellShares * sellPreview.avgPrice < 1.02) {
        notify({ kind: "SYSTEM", title: "CLOSE BLOCKED — BELOW CLOB $1 MINIMUM", body: `${sellShares.toFixed(2)} sh (~$${(sellShares * sellPreview.avgPrice).toFixed(2)}) is under the exchange's $1 order minimum; it rides to resolution.`, href: "/ai" });
        return;
      }
      const res = await signAndPlaceOrder(wClient, wAddr, {
        tokenId: p.tokenId,
        side: "SELL",
        price: snapToTick(Math.max(p.tickSize, sellPreview.avgPrice * 0.985 - p.tickSize), p.tickSize),
        shares: sellShares,
        tickSize: p.tickSize,
        negRisk: p.negRisk,
        orderType: "FAK",
      });
      if (!res.success) {
        notify({ kind: "SYSTEM", title: "MANUAL CLOSE FAILED", body: (res.errorMsg ?? "order rejected").slice(0, 160), href: "/ai" });
        return;
      }
      // SELL response: makingAmount = shares given, takingAmount = DOLLARS
      // received. Only a CONFIRMED fill is ledgered — an amountless/delayed
      // response must not fabricate proceeds or orphan real shares.
      let filled = Number(res.makingAmount);
      if (Number.isFinite(filled) && filled > sellShares * 1.05) filled = filled / 1e6;
      if (!Number.isFinite(filled) || filled <= 0) {
        if (res.status !== "matched") {
          notify({ kind: "SYSTEM", title: "CLOSE UNCONFIRMED", body: `Order ${res.status ?? "accepted"} but no fill reported — nothing ledgered. Check the Orders screen and retry.`, href: "/orders" });
          return;
        }
        filled = sellShares;
      }
      filled = Math.min(filled, sellShares);
      let proceeds = Number(res.takingAmount);
      if (Number.isFinite(proceeds) && proceeds > filled * 1.05) proceeds = proceeds / 1e6;
      if (!Number.isFinite(proceeds) || proceeds <= 0 || proceeds > filled * 1.05) proceeds = filled * sellPreview.avgPrice;
      const exitPx = proceeds / Math.max(filled, 0.01); // honest average fill, not the mid
      const exitFeeQuote = billing("SIGNAL", proceeds);
      const fullClose = filled >= p.shares - 0.01;
      if (fullClose) {
        desk.recordLiveClose(p.decisionId, exitPx, proceeds, exitFeeQuote.feeUsd, "MANUAL");
      } else {
        desk.recordLivePartialClose(p.decisionId, filled, exitPx, proceeds, exitFeeQuote.feeUsd, "MANUAL");
      }
      accrue(exitFeeQuote, { market: p.question, notionalUsd: proceeds });
      const frac = fullClose ? 1 : filled / p.shares;
      const pnl = proceeds - exitFeeQuote.feeUsd - p.costUsd * frac - p.feeUsd * frac;
      sendLiveMail({
        kind: "CLOSE",
        key: `close:${p.decisionId}:${fullClose ? "full" : Date.now()}`,
        title: `MANUAL CLOSE${fullClose ? "" : " (PARTIAL)"} — ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} NET`,
        detail: `${p.outcome.toUpperCase()} ${fullClose ? "closed" : `partially closed (${filled.toFixed(2)}/${p.shares.toFixed(2)} sh)`} by operator at ${(exitPx * 100).toFixed(1)}¢ avg (entry ${(p.entryPrice * 100).toFixed(1)}¢).`,
        market: p.question,
        outcome: p.outcome,
        entryPrice: p.entryPrice,
        exitPrice: exitPx,
        sizeUsd: p.costUsd * frac,
        pnlUsd: pnl,
        reason: "MANUAL",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ kind: "SYSTEM", title: "MANUAL CLOSE FAILED", body: msg.slice(0, 160), href: "/ai" });
    } finally {
      setClosingLive(null);
    }
  };

  const executeLive = async (d: DeskDecision) => {
    // silent-failure was the "execute does nothing" bug: every dead end now
    // tells the operator exactly what is blocking the order.
    // The armed session signer needs no extension wallet and no chain switch.
    if (!autoSign && !isConnected) {
      notify({
        kind: "SYSTEM",
        title: "AI DESK — WALLET REQUIRED",
        body: "Connect a wallet to execute. Phantom works via its Polygon (EVM) side — Polymarket settles on Polygon.",
        href: "/ai",
      });
      return;
    }
    if (!autoSign && chainId !== polygon.id) {
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
              {paperMode ? "SIMULATION VS THE REAL BOOK — ZERO FUNDS AT RISK." : "REAL EXECUTION — SAME ENGINE, REAL MONEY."}
            </p>
          </Field>

          {!paperMode && (!autoSign || hasOtherWalletPositions) && isConnected && chainId !== polygon.id && (
            <button
              onClick={() => switchChain({ chainId: polygon.id })}
              className="focus-outline border border-warn/50 bg-warn/10 px-2.5 py-2 text-left text-[9.5px] uppercase leading-relaxed tracking-[0.08em] text-warn2 transition-colors hover:bg-warn/20"
            >
              {autoSign
                ? "PHANTOM ON WRONG NETWORK — TAP TO SWITCH. YOUR MAIN-WALLET POSITIONS' EXITS CAN'T SIGN UNTIL IT'S ON POLYGON."
                : "WALLET ON WRONG NETWORK — TAP TO SWITCH TO POLYGON. PHANTOM: USE ITS POLYGON (EVM) SIDE; SOL ON SOLANA MUST BE BRIDGED/SWAPPED TO POLYGON USDC — POLYMARKET SETTLES ON POLYGON ONLY."}
            </button>
          )}
          {!paperMode && (!autoSign || hasOtherWalletPositions) && !isConnected && (
            <div className="border border-line bg-raise px-2.5 py-2 text-[9.5px] uppercase leading-relaxed tracking-[0.08em] text-dim">
              {autoSign
                ? "PHANTOM NOT CONNECTED — YOUR MAIN-WALLET POSITIONS' EXITS NEED IT RECONNECTED TO SIGN."
                : "NO WALLET CONNECTED — LIVE ORDERS NEED A POLYGON SIGNATURE. PHANTOM SUPPORTED VIA ITS POLYGON (EVM) SIDE."}
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
                      YOUR POLYMARKET PROXY — DEPOSITS ON POLYMARKET.COM LAND HERE.
                    </p>
                    {legacyBal > 0.5 && depositWallet?.toLowerCase() !== LEGACY_DEPOSIT_WALLET.toLowerCase() && (
                      <div className="mt-1.5 border border-warn/40 bg-warn/5 px-2 py-1.5">
                        <p className="text-[9px] leading-relaxed text-warn2">
                          {fmt.usd(legacyBal, { compact: false })} SITS IN A DIFFERENT SYSTEM WALLET
                          ({LEGACY_DEPOSIT_WALLET.slice(0, 8)}…). PULL IT BACK TO YOUR OWN WALLET.
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
                <div className="label-faint mb-1">DESK BUDGET — MAX THE DESK MAY DEPLOY</div>
                <div className="flex gap-px bg-line">
                  <button
                    onClick={() => desk.setConfig({ budgetAuto: true })}
                    className={cx(
                      "focus-outline h-8 flex-1 text-[8.5px] font-medium tracking-[0.08em] transition-colors",
                      config.budgetAuto ? "bg-raise3 text-pos" : "bg-raise2 text-faint hover:text-dim",
                    )}
                  >
                    AUTO — FOLLOW WALLET
                  </button>
                  <button
                    onClick={() => desk.setConfig({ budgetAuto: false })}
                    className={cx(
                      "focus-outline h-8 flex-1 text-[8.5px] font-medium tracking-[0.08em] transition-colors",
                      !config.budgetAuto ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                    )}
                  >
                    FIXED CAP $
                  </button>
                </div>
                {!config.budgetAuto && (
                  <div className="mt-1.5">
                    <NumField
                      label="FIXED BUDGET $"
                      value={config.budgetUsd}
                      onChange={(v) => desk.setConfig({ budgetUsd: v })}
                    />
                  </div>
                )}
                <p className="mt-1 text-[9px] leading-relaxed text-faint">
                  {config.budgetAuto
                    ? `TRACKS THE FULL WALLET (${tradingBal !== null ? fmt.usd(tradingBal, { compact: false }) : "—"}) — SIZING COMPOUNDS WITH PROFITS.`
                    : "BANKROLL = MIN(WALLET, BUDGET) — HARD CAP."}
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

          {!paperMode && <AutopilotSignerPanel />}

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
            <p className="mono-num mt-1 text-[9px] leading-relaxed text-faint">
              {config.tempo === "SCALP"
                ? "TP 4% · SL 5% · ≤15M HOLD · 6S SWEEP"
                : config.tempo === "INTRADAY"
                  ? "TP 12% · SL 8% · ≤4H HOLD · 20S SWEEP"
                  : "TP 20% · SL 12% · ≤24H HOLD · 45S SWEEP"}
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
                ? "SET CAPITAL + TARGET — THE DESK DERIVES THE REST."
                : "ALL SIZING AND RISK UNDER MANUAL CONTROL."}
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
            <span className="label-faint">SIGNAL RATE {bpsPct(signalRate)} · NON-CUSTODIAL</span>
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
            <div className="grid grid-cols-6 gap-6">
              <Metric
                label="WALLET EQUITY"
                value={<LiveNum value={liveEquity} format={(v) => fmt.usd(v, { compact: false })} className="text-[17px]" />}
                sub={depositWallet ? "cash + open marks" : "link trading wallet"}
                tone={liveSessionPnl >= 0 ? "pos" : "neg"}
              />
              <Metric
                label="CASH / DEPLOYED"
                value={<LiveNum value={tradingBal ?? 0} format={(v) => `${fmt.usd(v)} / ${fmt.usd(liveDeployed)}`} className="text-[17px]" />}
                sub={`${desk.liveExecuted.filter(kpiOwned).length}/${config.maxPositions} positions open${desk.liveExecuted.some((e) => !kpiOwned(e)) ? ` · +${desk.liveExecuted.filter((e) => !kpiOwned(e)).length} other wallet` : ""}`}
              />
              <Metric
                label="REALIZED P&L"
                value={<LiveNum value={liveRealized} format={(v) => fmt.usd(v, { sign: true, compact: false })} className="text-[17px]" />}
                tone={liveRealized >= 0 ? "pos" : "neg"}
                sub={`${desk.liveClosed.length} trades · ${desk.liveClosed.length ? Math.round((liveWins / desk.liveClosed.length) * 100) : 0}% win`}
              />
              <Metric
                label="UNREALIZED"
                value={<LiveNum value={liveUnrealized} format={(v) => fmt.usd(v, { sign: true, compact: false })} className="text-[17px]" />}
                tone={liveUnrealized >= 0 ? "pos" : "neg"}
                sub="live marks"
              />
              <Metric
                label="FEES PAID (REAL)"
                value={<LiveNum value={liveFeesPaid} format={(v) => fmt.usd(v, { compact: false })} className="text-[17px]" />}
                sub={`at ${bpsPct(signalRate)} signal rate`}
              />
              <div className="flex flex-col gap-1">
                <div className="label-faint">TARGET — {fmt.usd(config.targetProfitUsd)}</div>
                <LiveNum
                  value={liveSessionPnl}
                  format={(v) => fmt.usd(v, { sign: true, compact: false })}
                  className={cx("text-[17px] leading-none", liveSessionPnl >= 0 ? "text-pos" : "text-neg")}
                />
                <div className="h-[3px] w-full bg-raise3">
                  <div className="h-full bg-pos/70 transition-[width] duration-700 ease-out" style={{ width: `${liveTargetProgress * 100}%` }} />
                </div>
                {desk.lockedProfitUsd > 0 && (
                  <div className="text-[10px] leading-tight text-warn2">
                    {fmt.usd(desk.lockedProfitUsd, { compact: false })} BANKED — UNTOUCHABLE
                  </div>
                )}
              </div>
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
          {!paperMode && liveAutoStatus && (
            <div className="mono-num mt-2 border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-[9.5px] uppercase leading-relaxed tracking-[0.08em] text-warn2">
              AUTOPILOT — {liveAutoStatus}
            </div>
          )}
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

          {/* open positions (live) */}
          {!paperMode && (
            <Panel className="col-span-3 border-0" title="OPEN POSITIONS — LIVE MARKS" pad={false}>
              {!desk.liveExecuted.length ? (
                <Empty
                  label={engaged ? "SCANNING FOR ENTRIES" : "NO OPEN POSITIONS"}
                  hint={engaged ? "ARM auto-stages the best qualifying proposal; your wallet signs each fill." : "Engage the desk in LIVE mode to begin."}
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
                    {desk.liveExecuted.map((p) => {
                      const mark = markOf(p.tokenId, p.entryPrice);
                      const pnl = (mark - p.entryPrice) * p.shares;
                      // below the exchange's own $1 order minimum — no CLOSE
                      // attempt can ever succeed; say so instead of offering
                      // a button that only bounces "not enough" every click
                      const isDust = p.shares * mark < 1.02;
                      return (
                        <tr key={p.decisionId} className="hairline-b h-10 row-hover">
                          <td className="max-w-0 truncate px-3 text-[11.5px] text-text">
                            <button onClick={() => navigate(`/market/${p.slug}`)} className="hover:text-accent2">{p.question}</button>
                          </td>
                          <td className="px-2 text-[10px] font-semibold text-pos">{p.outcome.toUpperCase()}</td>
                          <td className="mono-num px-2 text-right text-[10.5px] text-dim">
                            <LiveNum value={mark} format={(v) => `${(p.entryPrice * 100).toFixed(1)}¢ → ${(v * 100).toFixed(1)}¢`} />
                          </td>
                          <td className="mono-num px-2 text-right text-[10px] text-faint">
                            {(p.tpPrice * 100).toFixed(0)} / {(p.slPrice * 100).toFixed(0)}
                          </td>
                          <td className="mono-num px-2 text-right text-[11px] text-text">{fmt.usd(p.costUsd)}</td>
                          <td className={cx("mono-num px-2 text-right text-[11px]", pnl >= 0 ? "text-pos" : "text-neg")}>
                            <LiveNum value={pnl} format={(v) => fmt.usd(v, { sign: true, compact: false })} />
                          </td>
                          <td className="mono-num px-2 text-right text-[10px] text-faint">{fmt.timeAgo(p.ts)}</td>
                          <td className="px-2 text-right">
                            {isDust ? (
                              <span className="label-faint text-[9px] text-faint" title="Below the exchange's $1 order minimum — rides to resolution.">
                                DUST
                              </span>
                            ) : (
                              <Btn size="sm" variant="ghost" disabled={closingLive === p.decisionId} onClick={() => void manualCloseLive(p)}>
                                {closingLive === p.decisionId ? "CLOSING…" : "CLOSE"}
                              </Btn>
                            )}
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
                    <ul className="mt-1.5 flex flex-col gap-0.5" title={d.reasons.join("\n")}>
                      {d.reasons.slice(0, 2).map((r) => (
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
          <Panel className="border-0" title={paperMode ? "SESSION LEDGER — CLOSED TRADES" : "LIVE EXECUTION LOG — CLOSED TRADES"} pad={false}>
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
            ) : !desk.liveClosed.length ? (
              <Empty label="NO CLOSED TRADES" hint="Real fills settle here once TP, SL, time-exit or a manual close confirms." />
            ) : (
              <div className="flex max-h-[520px] flex-col overflow-y-auto">
                {desk.liveClosed.map((t) => (
                  <Link key={t.decisionId + t.closedTs} to={`/market/${t.slug}`} className="hairline-b row-hover block px-3 py-2.5">
                    <div className="line-clamp-1 text-[11px] text-text">{t.question}</div>
                    <div className="mono-num mt-1 flex items-center gap-2.5 text-[10px]">
                      <Tag tone={t.reason === "TAKE_PROFIT" || (t.reason === "RESOLVED" && t.pnl >= 0) ? "pos" : t.reason === "STOP_LOSS" || (t.reason === "RESOLVED" && t.pnl < 0) ? "neg" : "dim"}>
                        {t.reason.replaceAll("_", " ")}
                      </Tag>
                      {t.awaitingRedeem && (
                        <a
                          href="https://polymarket.com/portfolio"
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="border border-accent/50 bg-accent/10 px-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-accent2 hover:bg-accent/20"
                        >
                          REDEEM ↗
                        </a>
                      )}
                      <span className="text-faint">
                        {(t.entryPrice * 100).toFixed(1)}¢ → {(t.exitPrice * 100).toFixed(1)}¢
                      </span>
                      <span className="text-faint">{fmt.timeAgo(t.closedTs)} AGO</span>
                      <span className={cx("ml-auto text-[11px]", t.pnl >= 0 ? "text-pos" : "text-neg")}>
                        {fmt.usd(t.pnl, { sign: true, compact: false })}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** AUTOPILOT SIGNER — dedicated local trading key so LIVE orders sign with
 *  ZERO wallet prompts. Hot key by design (operator's explicit request);
 *  the UI is blunt about the trade-off and the one-time Polymarket setup. */
function AutopilotSignerPanel() {
  const sess = useSessionSigner();
  const notify = useNotifications((s) => s.push);
  const liveOpen = useAiDesk((s) => s.liveExecuted);
  const setDeskConfig = useAiDesk((s) => s.setConfig);
  const desk = { setConfig: setDeskConfig };
  const { address: connectedAddress } = useAccount();
  const [reveal, setReveal] = useState(false);
  const [importVal, setImportVal] = useState("");
  const [proxyVal, setProxyVal] = useState("");
  const addr = sess.pk ? sessionAddress() : null;
  const armed = sess.enabled && !!sess.pk && !!sess.proxyWallet;
  // positions whose shares sit in the SESSION proxy — only this key can ever
  // sell them; destroying it while they're open strands real money forever
  const sessionOwnedOpen = addr ? liveOpen.filter((e) => e.owner === addr.toLowerCase()) : [];
  const phantomOwnedOpen = liveOpen.filter((e) => !addr || e.owner !== addr.toLowerCase());
  // POLY_PROXY_WALLET is authorized ONLY for the main EOA (confirmed on-chain,
  // v21) — linking it to any OTHER signer produces an order the exchange can
  // never accept ("does not match auth"/maker mismatch), every single time.
  // This exact mistake happens when a burner key gets the main account's own
  // proxy pasted into it by hand (e.g. copied from the TRADING WALLET panel).
  const proxyMismatch =
    !!addr &&
    !!connectedAddress &&
    !!sess.proxyWallet &&
    sess.proxyWallet.toLowerCase() === POLY_PROXY_WALLET.toLowerCase() &&
    addr.toLowerCase() !== connectedAddress.toLowerCase();

  return (
    <div className={cx("border px-2.5 py-2", armed ? "border-pos/50 bg-pos/[0.05]" : "border-line bg-raise")}>
      <div className="flex items-center justify-between">
        <span className={cx("label text-[9px]", armed ? "text-pos" : "text-accent2")}>
          AUTOPILOT SIGNER — ZERO WALLET PROMPTS
        </span>
        {sess.pk && sess.proxyWallet && (
          <button
            onClick={() => sess.setEnabled(!sess.enabled)}
            className={cx(
              "focus-outline h-6 border px-2 text-[9px] font-semibold uppercase tracking-[0.1em] transition-colors",
              armed ? "border-pos/60 bg-pos/15 text-pos" : "border-line bg-raise2 text-dim hover:text-text",
            )}
          >
            {armed ? "ARMED — CLICK TO DISARM" : "ARM"}
          </button>
        )}
      </div>

      {!sess.pk ? (
        <>
          <p className="mt-1.5 text-[9px] leading-relaxed text-faint">
            PASTE YOUR KEY ONCE — THE DESK SIGNS EVERY ORDER SILENTLY. HOT KEY, THIS BROWSER ONLY.
          </p>
          <p className="mt-1 text-[9px] leading-relaxed text-accent2">
            PHANTOM → SETTINGS → MANAGE ACCOUNTS → SHOW PRIVATE KEY (ETHEREUM) → PASTE → IMPORT.
          </p>
          <div className="mt-1.5 flex gap-1">
            <input
              value={importVal}
              onChange={(e) => setImportVal(e.target.value)}
              placeholder="PASTE PHANTOM PRIVATE KEY (0x…)"
              className="focus-outline mono-num h-7 min-w-0 flex-1 border border-accent/40 bg-raise2 px-2 text-[9.5px] text-text placeholder:text-faint"
            />
            <Btn
              size="sm"
              variant="yes"
              onClick={() => {
                const a = sess.importKey(importVal);
                if (!a) {
                  notify({ kind: "SYSTEM", title: "INVALID PRIVATE KEY", body: "Expected a 64-hex-char key (0x-prefixed).", href: "/ai" });
                  return;
                }
                setImportVal("");
                // same account as the connected wallet → its proxy is the one
                // we already confirmed on-chain; link, ARM, and it's live
                if (connectedAddress && a.toLowerCase() === connectedAddress.toLowerCase()) {
                  sess.setProxyWallet(POLY_PROXY_WALLET);
                  sess.setEnabled(true);
                  desk.setConfig({ mode: "ARM" }); // hands-free: the desk stages + fills itself
                  notify({ kind: "SYSTEM", title: "AUTOPILOT ARMED — SAME ACCOUNT", body: "Key matches your wallet; trading wallet auto-linked, staging set to ARM, signing silently. Hit ENGAGE DESK and it trades hands-free at paper speed.", href: "/ai" });
                } else {
                  notify({ kind: "SYSTEM", title: "AUTOPILOT KEY IMPORTED", body: `Session signer ${a.slice(0, 10)}… ready — link its proxy wallet below.`, href: "/ai" });
                }
              }}
            >
              IMPORT
            </Btn>
          </div>
          <p className="mt-1.5 text-[9px] leading-relaxed text-faint">
            SAFER ALTERNATIVE — DEDICATED BURNER (NEEDS ITS OWN POLYMARKET DEPOSIT):
          </p>
          <button
            onClick={() => {
              const a = sess.generate();
              notify({ kind: "SYSTEM", title: "AUTOPILOT KEY GENERATED", body: `Session signer ${a.slice(0, 10)}… created — complete the one-time Polymarket setup.`, href: "/ai" });
            }}
            className="focus-outline mt-1 flex h-8 w-full items-center justify-center border border-line bg-raise2 text-[10px] font-medium uppercase tracking-[0.1em] text-dim transition-colors hover:text-text"
          >
            GENERATE FRESH BURNER KEY
          </button>
        </>
      ) : (
        <>
          <div className="mono-num mt-1.5 flex items-center justify-between text-[9.5px] tabular-nums">
            <span className="text-dim">SIGNER {addr?.slice(0, 8)}…{addr?.slice(-6)}</span>
            <button onClick={() => setReveal((v) => !v)} className="focus-outline text-[9px] uppercase tracking-[0.1em] text-faint hover:text-warn2">
              {reveal ? "HIDE KEY" : "REVEAL KEY"}
            </button>
          </div>
          {reveal && (
            <div className="mono-num mt-1 break-all border border-warn/40 bg-warn/5 px-2 py-1.5 text-[8.5px] text-warn2">
              {sess.pk}
            </div>
          )}
          {!sess.proxyWallet ? (
            <>
              <p className="mt-1.5 text-[9px] leading-relaxed text-warn2">
                1) IMPORT KEY INTO PHANTOM · 2) DEPOSIT ON POLYMARKET.COM AS THAT ACCOUNT ·
                3) PASTE ITS PROFILE "COPY ADDRESS" BELOW · 4) ARM.
              </p>
              <div className="mt-1.5 flex gap-1">
                <input
                  value={proxyVal}
                  onChange={(e) => setProxyVal(e.target.value)}
                  placeholder="SESSION PROXY WALLET (POLYMARKET PROFILE ADDRESS)"
                  className="focus-outline mono-num h-7 min-w-0 flex-1 border border-line bg-raise2 px-2 text-[9.5px] text-text placeholder:text-faint"
                />
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // this specific proxy is confirmed authorized ONLY for the
                    // main EOA — linking it to any other signer can NEVER
                    // place an order the exchange will accept, so refuse
                    // before the operator wastes a cycle finding out the hard way
                    if (
                      addr &&
                      connectedAddress &&
                      addr.toLowerCase() !== connectedAddress.toLowerCase() &&
                      proxyVal.trim().toLowerCase() === POLY_PROXY_WALLET.toLowerCase()
                    ) {
                      notify({
                        kind: "SYSTEM",
                        title: "WRONG PROXY — BELONGS TO YOUR MAIN ACCOUNT",
                        body: "That address is your MAIN wallet's own trading proxy — this burner key has no authority over it; every order would bounce. Either import your MAIN Phantom private key above instead, or deposit into a NEW Polymarket account logged in as THIS key's own address and paste ITS OWN profile proxy.",
                        href: "/ai",
                      });
                      return;
                    }
                    if (sess.setProxyWallet(proxyVal)) {
                      setProxyVal("");
                      notify({ kind: "SYSTEM", title: "AUTOPILOT PROXY LINKED", body: "Session trading wallet set — ARM to trade with zero prompts.", href: "/ai" });
                    } else {
                      notify({ kind: "SYSTEM", title: "INVALID ADDRESS", body: "Expected a 0x… Polygon address from your Polymarket profile.", href: "/ai" });
                    }
                  }}
                >
                  LINK
                </Btn>
              </div>
            </>
          ) : proxyMismatch ? (
            <>
              <div className="mono-num mt-1 text-[9.5px] tabular-nums text-neg2">
                PROXY {sess.proxyWallet.slice(0, 8)}…{sess.proxyWallet.slice(-6)} — WRONG WALLET
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-neg2">
                THIS IS YOUR MAIN ACCOUNT'S OWN TRADING PROXY — THIS BURNER KEY HAS NO AUTHORITY
                OVER IT. EVERY ORDER WILL BOUNCE ("DOES NOT MATCH") FOREVER UNTIL THIS IS FIXED.
                CLEAR IT, THEN EITHER IMPORT YOUR MAIN PHANTOM PRIVATE KEY ABOVE (FASTEST), OR
                DEPOSIT INTO A NEW POLYMARKET ACCOUNT AS THIS KEY'S OWN ADDRESS AND LINK ITS OWN PROXY.
              </p>
              <button
                onClick={() => sess.clearProxy()}
                className="focus-outline mt-1.5 flex h-7 w-full items-center justify-center border border-neg/40 bg-neg/5 text-[9px] font-medium uppercase tracking-[0.1em] text-neg2 transition-colors hover:bg-neg/10"
              >
                CLEAR WRONG PROXY
              </button>
            </>
          ) : (
            <div className="mono-num mt-1 flex items-center justify-between text-[9.5px] tabular-nums">
              <span className="text-faint">PROXY {sess.proxyWallet.slice(0, 8)}…{sess.proxyWallet.slice(-6)}</span>
              <span className={armed ? "text-pos" : "text-faint"}>{armed ? "SIGNING SILENTLY" : "DISARMED"}</span>
            </div>
          )}
          <p className="mt-1.5 text-[9px] leading-relaxed text-faint">
            {armed
              ? "ARMED — ENTRIES + EXITS SIGN SILENTLY AT FULL SPEED."
              : "DISARMED — ORDERS FALL BACK TO PHANTOM, ONE PROMPT EACH."}
          </p>
          {armed && phantomOwnedOpen.length > 0 && (
            <p className="mt-1 text-[9px] leading-relaxed text-warn2">
              {phantomOwnedOpen.length} POSITION{phantomOwnedOpen.length > 1 ? "S" : ""} ON THE MAIN
              WALLET — KEEP PHANTOM CONNECTED (POLYGON) FOR THEIR EXITS.
            </p>
          )}
          <button
            onClick={() => {
              if (sessionOwnedOpen.length > 0) {
                notify({
                  kind: "SYSTEM",
                  title: "REMOVE BLOCKED — OPEN SESSION POSITIONS",
                  body: `${sessionOwnedOpen.length} open position(s) can ONLY be sold by this key. Close them (or wait for exits), withdraw the proxy funds, then remove.`,
                  href: "/ai",
                });
                return;
              }
              if (window.confirm("Remove the autopilot key from this browser? Withdraw the session proxy's funds first — the key CANNOT be recovered and anything left behind is unreachable forever.")) {
                sess.clear();
                setReveal(false);
              }
            }}
            className="focus-outline mt-1.5 flex h-7 w-full items-center justify-center border border-neg/40 bg-neg/5 text-[9px] font-medium uppercase tracking-[0.1em] text-neg2 transition-colors hover:bg-neg/10"
          >
            REMOVE KEY FROM THIS BROWSER
          </button>
        </>
      )}
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
