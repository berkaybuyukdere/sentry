import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { X, ShieldCheck, ShieldAlert } from "lucide-react";
import { useAccount, useWalletClient, useSwitchChain } from "wagmi";
import { polygon } from "wagmi/chains";
import { bookStats, estimateFill, fmt } from "@sentry-app/polymarket";
import { useOrderBook } from "../../lib/queries";
import { useTicket } from "./ticket";
import { signAndPlaceOrder, snapToTick, type PlacedOrder } from "../../lib/trading/orders";
import { useProvision } from "../../lib/trading/provision";
import { useOrderLog } from "../../lib/trading/orderLog";
import { useNotifications } from "../../lib/alerts";
import { useBilling, bpsPct } from "../../lib/billing";
import { Btn, Tag, cx } from "../ui/primitives";
import { WalletModal } from "../shell/WalletModal";

type Phase = "compose" | "signing" | "done" | "error";

export function ExecutionPanel() {
  const { open, market, outcomeIndex, side, presetUsd, origin, sourceOperator, auto, close } = useTicket();
  const billingQuote = useBilling((s) => s.quote);
  const accrue = useBilling((s) => s.accrue);
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();
  const provision = useProvision();
  const logOrder = useOrderLog((s) => s.log);
  const notify = useNotifications((s) => s.push);

  const tokenId = market?.clobTokenIds[outcomeIndex];
  const { data: book } = useOrderBook(open ? tokenId : undefined, 5000);

  const [usd, setUsd] = useState(100);
  const [orderMode, setOrderMode] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limitPrice, setLimitPrice] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("compose");
  const [result, setResult] = useState<PlacedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setPhase("compose");
      setResult(null);
      setError(null);
      setOrderMode("MARKET");
      setLimitPrice(null);
      autoFired.current = false;
      if (presetUsd) setUsd(Math.round(presetUsd));
    }
  }, [open, market?.id, presetUsd]);

  const stats = useMemo(() => (book ? bookStats(book) : null), [book]);

  const est = useMemo(() => {
    if (!market) return null;
    if (side === "BUY") {
      if (orderMode === "MARKET") {
        if (!stats) return null;
        const f = estimateFill(stats.asks, usd);
        return { price: f.avgPrice, shares: f.shares, exhausted: f.exhausted };
      }
      const p = limitPrice ?? stats?.bestBid ?? market.probability;
      return { price: p, shares: p > 0 ? usd / p : 0, exhausted: false };
    }
    // SELL: usd field is interpreted as share count for sells
    const p =
      orderMode === "MARKET"
        ? (stats?.bestBid ?? market.probability)
        : (limitPrice ?? stats?.bestAsk ?? market.probability);
    return { price: p, shares: usd, exhausted: false };
  }, [market, side, orderMode, limitPrice, stats, usd]);

  const autoFired = useRef(false);
  const executeRef = useRef<null | (() => Promise<void>)>(null);

  // ARM auto-execution: the desk staged this ticket — submit as soon as the
  // live book estimate exists. The wallet's signature prompt is the ONLY
  // remaining human step (protocol-required; SENTRY never holds keys).
  useEffect(() => {
    if (!open || !auto || autoFired.current || phase !== "compose") return;
    if (!market || !est || orderMode !== "MARKET") return;
    if (!isConnected || chainId !== polygon.id) return;
    const t = setTimeout(() => {
      autoFired.current = true;
      void executeRef.current?.();
    }, 400);
    return () => clearTimeout(t);
  });

  // ARM flow continues on its own: close after success so the desk stages the
  // next proposal; close after a fault too (rejected signature / CLOB error).
  useEffect(() => {
    if (!open || !auto || (phase !== "done" && phase !== "error")) return;
    const t = setTimeout(close, phase === "done" ? 1500 : 2500);
    return () => clearTimeout(t);
  }, [open, auto, phase, close]);

  if (!open || !market) return null;

  const outcome = market.outcomes[outcomeIndex] ?? "—";
  const execNotional = side === "BUY" ? usd : est ? est.shares * est.price : 0;
  const fee = billingQuote(origin, execNotional, sourceOperator?.rank ?? null);
  const wrongChain = isConnected && chainId !== polygon.id;
  // v2: orders are gasless EIP-712 from the deposit wallet; the official
  // client manages its own approvals — legacy EOA grants no longer gate
  const canTrade = isConnected && !wrongChain;
  const tick = market.tickSize;

  const execute = async () => {
    if (!walletClient || !address || !tokenId || !est) return;
    setPhase("signing");
    setError(null);
    try {
      const price =
        orderMode === "MARKET"
          ? side === "BUY"
            ? Math.min(1 - tick, est.price * 1.02 + tick) // slippage guard
            : Math.max(tick, est.price * 0.98 - tick)
          : (limitPrice ?? est.price);
      const snapped = snapToTick(price, tick);
      const shares = Math.floor((side === "BUY" ? usd / snapped : usd) * 100) / 100;
      const res = await signAndPlaceOrder(walletClient, address, {
        tokenId,
        side,
        price: snapped,
        shares,
        tickSize: tick,
        negRisk: market.negRisk,
        orderType: orderMode === "MARKET" ? "FAK" : "GTC",
      });
      setResult(res);
      const entry = logOrder({
        market: market.question,
        slug: market.slug,
        side,
        outcome,
        price: snapped,
        shares,
        usd: side === "BUY" ? usd : shares * snapped,
        orderType: orderMode === "MARKET" ? "FAK" : "GTC",
        clobOrderId: res.orderID ?? null,
        txHash: res.transactionsHashes?.[0] ?? null,
        status: res.status ?? (res.success ? "SUBMITTED" : "REJECTED"),
        error: res.errorMsg || null,
      });
      if (res.success) {
        setPhase("done");
        accrue(fee, {
          market: market.question,
          notionalUsd: execNotional,
          operatorWallet: sourceOperator?.wallet ?? null,
        });
        notify({
          kind: "ORDER",
          title: "ORDER CONFIRMED",
          body: `${side} ${outcome} · ${market.question} · ${fmt.usd(side === "BUY" ? usd : shares * snapped)} @ ${(snapped * 100).toFixed(1)}¢ · POSITION ID ${entry.id}`,
          href: "/orders",
        });
      } else {
        setPhase("error");
        setError(res.errorMsg || "Order rejected by CLOB");
      }
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Execution failed");
    }
  };
  executeRef.current = execute;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={close}>
      <aside
        className="hairline-l flex h-full w-[380px] flex-col overflow-y-auto bg-raise"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="hairline-b flex h-10 shrink-0 items-center justify-between px-3">
          <span className="label">ORDER EXECUTION</span>
          <button onClick={close} className="focus-outline text-faint hover:text-text">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-4">
          {/* market context */}
          <div>
            <div className="text-[12.5px] leading-snug text-text">{market.question}</div>
            <div className="mt-1.5 flex items-center gap-2">
              <Tag tone={side === "BUY" ? "pos" : "neg"}>
                {side} {outcome}
              </Tag>
              <Tag tone={origin === "MANUAL" ? "dim" : origin === "SIGNAL" ? "accent" : "pos"}>{origin}</Tag>
              {market.negRisk && <Tag>NEG-RISK</Tag>}
              <span className="mono-num ml-auto text-[10px] text-faint">
                TICK {tick} · MIN {market.minOrderSize}
              </span>
            </div>
          </div>

          {/* live microstructure */}
          <div className="grid grid-cols-3 gap-px bg-line">
            {[
              { l: "BID", v: stats?.bestBid, tone: "text-pos" },
              { l: "ASK", v: stats?.bestAsk, tone: "text-neg" },
              { l: "MID", v: stats && stats.bestBid !== null && stats.bestAsk !== null ? (stats.bestBid + stats.bestAsk) / 2 : null, tone: "text-text" },
            ].map((c) => (
              <div key={c.l} className="bg-raise px-2.5 py-2">
                <div className="label-faint">{c.l}</div>
                <div className={cx("mono-num mt-0.5 text-[13px]", c.tone)}>
                  {c.v != null ? `${(c.v * 100).toFixed(1)}¢` : "—"}
                </div>
              </div>
            ))}
          </div>

          {/* order form */}
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-px bg-line">
              {(["MARKET", "LIMIT"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setOrderMode(m)}
                  className={cx(
                    "focus-outline h-7 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors",
                    orderMode === m ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>

            {orderMode === "LIMIT" && (
              <div>
                <div className="label-faint mb-1">LIMIT PRICE (¢)</div>
                <input
                  type="number"
                  min={tick * 100}
                  max={100 - tick * 100}
                  step={tick * 100}
                  value={limitPrice !== null ? Math.round(limitPrice * 1000) / 10 : ""}
                  placeholder={stats?.bestBid ? (stats.bestBid * 100).toFixed(1) : "—"}
                  onChange={(e) => setLimitPrice(Number(e.target.value) / 100)}
                  className="focus-outline mono-num h-8 w-full border border-line bg-raise2 px-2.5 text-[13px] text-text"
                />
              </div>
            )}

            <div>
              <div className="label-faint mb-1">{side === "BUY" ? "POSITION SIZE (USDC)" : "SHARES TO SELL"}</div>
              <input
                type="number"
                min={1}
                value={usd}
                onChange={(e) => setUsd(Math.max(0, Number(e.target.value)))}
                className="focus-outline mono-num h-9 w-full border border-line bg-raise2 px-2.5 text-[15px] text-text"
              />
              <div className="mt-1.5 grid grid-cols-4 gap-px bg-line">
                {(side === "BUY" ? [50, 100, 250, 500] : [10, 50, 100, 500]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setUsd(v)}
                    className="focus-outline h-6 bg-raise text-[10px] text-faint transition-colors hover:bg-raise3 hover:text-dim"
                  >
                    {side === "BUY" ? `$${v}` : v}
                  </button>
                ))}
              </div>
            </div>

            {/* estimate */}
            <div className="border border-line bg-raise2 p-3">
              <div className="grid grid-cols-2 gap-y-2">
                <div>
                  <div className="label-faint">AVG PRICE</div>
                  <div className="mono-num mt-0.5 text-[13px] text-text">
                    {est ? `${(est.price * 100).toFixed(1)}¢` : "—"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="label-faint">{side === "BUY" ? "EST. SHARES" : "EST. PROCEEDS"}</div>
                  <div className="mono-num mt-0.5 text-[13px] text-text">
                    {est
                      ? side === "BUY"
                        ? fmt.num(est.shares, 2)
                        : fmt.usd(est.shares * est.price, { compact: false })
                      : "—"}
                  </div>
                </div>
                {side === "BUY" && (
                  <>
                    <div>
                      <div className="label-faint">MAX RETURN</div>
                      <div className="mono-num mt-0.5 text-[13px] text-pos">
                        {est ? fmt.usd(est.shares, { compact: false }) : "—"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="label-faint">MAX PROFIT</div>
                      <div className="mono-num mt-0.5 text-[13px] text-pos">
                        {est ? `+${fmt.usd(est.shares - usd, { compact: false }).slice(1)}` : "—"}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {est?.exhausted && (
                <div className="mt-2 border border-warn/40 bg-warn/5 px-2 py-1 text-[10px] text-warn2">
                  ORDER EXCEEDS VISIBLE BOOK DEPTH — EXPECT PARTIAL FILL
                </div>
              )}
              <div className="hairline-t mt-2.5 pt-2">
                <div className="flex items-center justify-between">
                  <span className="label-faint">EXECUTION RATE</span>
                  <span className="mono-num text-[11px] text-text">
                    {bpsPct(fee.rateBps)} <span className="text-faint">· {fmt.usd(fee.feeUsd, { compact: false })}</span>
                  </span>
                </div>
                {origin === "COPY" && sourceOperator && (
                  <div className="mt-1 flex items-center justify-between">
                    <span className="label-faint">OPERATOR REWARD — {sourceOperator.alias.toUpperCase().slice(0, 14)}</span>
                    <span className="mono-num text-[10px] text-dim">{bpsPct(fee.operatorRewardBps)}</span>
                  </div>
                )}
                <div className="mt-1 text-[9px] leading-relaxed text-faint">
                  APPLIED ONLY TO SUCCESSFULLY EXECUTED NOTIONAL. UNFILLED ORDERS ACCRUE NOTHING.
                </div>
              </div>
            </div>
          </div>

          {/* gates + execute */}
          {!isConnected ? (
            <Btn variant="accent" size="lg" onClick={() => setWalletOpen(true)}>
              CONNECT WALLET TO EXECUTE
            </Btn>
          ) : wrongChain ? (
            <Btn variant="accent" size="lg" onClick={() => switchChain({ chainId: polygon.id })}>
              SWITCH TO POLYGON
            </Btn>
          ) : !provision.provisioned ? (
            <ProvisionBlock />
          ) : phase === "done" && result ? (
            <div className="border border-pos/40 bg-pos/5 p-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={13} className="text-pos" strokeWidth={1.5} />
                <span className="label text-pos">ORDER CONFIRMED</span>
              </div>
              <div className="mono-num mt-2 flex flex-col gap-1 text-[10.5px] text-dim">
                <span>STATUS — {(result.status ?? "SUBMITTED").toUpperCase()}</span>
                {result.orderID && <span className="truncate">CLOB ID — {result.orderID}</span>}
                {result.makingAmount && <span>MAKING — {result.makingAmount}</span>}
                {result.takingAmount && <span>TAKING — {result.takingAmount}</span>}
              </div>
              <Btn className="mt-3 w-full" onClick={close}>
                RETURN TO TERMINAL
              </Btn>
            </div>
          ) : (
            <>
              <button
                onClick={execute}
                disabled={phase === "signing" || !est || usd <= 0 || (side === "BUY" && provision.usdcBalance !== null && usd > provision.usdcBalance)}
                className={cx(
                  "focus-outline h-10 w-full border text-[12px] font-semibold uppercase tracking-[0.16em] transition-colors active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
                  side === "BUY"
                    ? "border-pos/60 bg-pos/15 text-pos2 hover:bg-pos/25"
                    : "border-neg/60 bg-neg/15 text-neg2 hover:bg-neg/25",
                )}
              >
                {phase === "signing" ? "AWAITING SIGNATURE…" : `EXECUTE ${side === "BUY" ? outcome.toUpperCase() : `${side} ${outcome.toUpperCase()}`} POSITION`}
              </button>
              {side === "BUY" && provision.usdcBalance !== null && usd > provision.usdcBalance && (
                <div className="text-[10px] text-warn2">
                  INSUFFICIENT USDC — AVAILABLE {fmt.usd(provision.usdcBalance, { compact: false })}{" "}
                  <Link to="/treasury" className="text-accent2 underline decoration-line underline-offset-2">
                    FUND VIA TREASURY
                  </Link>
                </div>
              )}
              {phase === "error" && error && (
                <div className="border border-neg/40 bg-neg/5 px-2.5 py-2 text-[10.5px] leading-relaxed text-neg2">
                  EXECUTION FAULT — {error}
                </div>
              )}
            </>
          )}

          <div className="hairline-t flex items-center justify-between pt-2">
            <span className="label-faint">EIP-712 · CLIENT-SIDE SIGNATURE</span>
            <span className="label-faint">POLYMARKET CLOB</span>
          </div>
        </div>
      </aside>
      {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    </div>,
    document.body,
  );
}

function ProvisionBlock() {
  const { steps, approving, loading, polBalance, usdcBalance, gasReady } = useProvision();
  const missing = steps.filter((s) => !s.granted);
  const noFunds = usdcBalance !== null && usdcBalance < 1;
  return (
    <div className="border border-warn/40 bg-warn/5 p-3">
      <div className="flex items-center gap-2">
        <ShieldAlert size={13} className="text-warn" strokeWidth={1.5} />
        <span className="label text-warn">WALLET NOT PROVISIONED FOR SETTLEMENT</span>
      </div>
      <div className="mono-num mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
        <span className="text-faint">POL (GAS)</span>
        <span className={cx("text-right", gasReady ? "text-pos" : "text-neg2")}>
          {polBalance !== null ? polBalance.toFixed(4) : "—"}
        </span>
        <span className="text-faint">USDC.E (COLLATERAL)</span>
        <span className={cx("text-right", noFunds ? "text-neg2" : "text-pos")}>
          {usdcBalance !== null ? fmt.usd(usdcBalance, { compact: false }) : "—"}
        </span>
      </div>
      {!gasReady && polBalance !== null && (
        <div className="mt-2 border border-neg/40 bg-neg/5 px-2 py-1.5 text-[10px] leading-relaxed text-neg2">
          NO POL GAS ON POLYGON — every approval reverts in your wallet's simulator (the "failed to
          simulate / unsafe" popup). Approvals are locked until the wallet holds ≥0.01 POL.
          {" "}SOL sitting on the Solana network cannot pay Polygon gas.
          <a
            href="https://jumper.exchange/?fromChain=1151111081099710&fromToken=11111111111111111111111111111111&toChain=137&toToken=0x0000000000000000000000000000000000000000"
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 flex h-7 items-center justify-center border border-neg/50 bg-neg/10 text-[9.5px] font-medium uppercase tracking-[0.1em] text-neg2 transition-colors hover:bg-neg/20"
          >
            GET POL GAS — SOL → POL (PRE-FILLED BRIDGE)
          </a>
        </div>
      )}
      {noFunds && (
        <div className="mt-1.5 text-[10px] leading-relaxed text-dim">
          POLYGON USDC.E IS EMPTY — bridge/swap funds to Polygon first.{" "}
          <Link to="/treasury" className="text-accent2 underline decoration-line underline-offset-2">
            TREASURY — FUNDING ROUTES (PHANTOM/SOLANA GUIDE)
          </Link>
        </div>
      )}
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-dim">
        One-time on-chain approvals let the Polymarket exchange contracts settle your signed
        orders. Grant each from your own wallet:
      </p>
      <div className="mt-2 flex flex-col gap-1">
        {loading ? (
          <span className="label-faint">READING CHAIN STATE…</span>
        ) : (
          steps.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-2">
              <span className="mono-num text-[10px] text-dim">{s.label}</span>
              {s.granted ? (
                <span className="mono-num text-[9px] tracking-[0.1em] text-pos">GRANTED</span>
              ) : (
                <Btn
                  size="sm"
                  variant="accent"
                  disabled={approving || !gasReady}
                  title={gasReady ? undefined : "Needs POL gas on Polygon"}
                  onClick={s.execute}
                >
                  APPROVE
                </Btn>
              )}
            </div>
          ))
        )}
      </div>
      {missing.length === 0 && steps.length > 0 && (
        <div className="mono-num mt-2 text-[9px] tracking-[0.1em] text-pos">PROVISIONING COMPLETE</div>
      )}
    </div>
  );
}
