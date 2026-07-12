import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { smartWalletSet, fmt } from "@sentry-app/polymarket";
import { useTape } from "../lib/tape";
import { useLeaderboard } from "../lib/queries";
import { NetworkGraph } from "../components/charts/NetworkGraph";
import { Panel, Loading, Tag, cx } from "../components/ui/primitives";
import { TxLink } from "../components/ui/ExtLink";

/** ACTIVITY — the raw live tape + the network intelligence graph over it. */
export function ActivityScreen() {
  const trades = useTape((s) => s.trades);
  const { data: lb } = useLeaderboard("30d", 50);
  const [minUsd, setMinUsd] = useState(500);
  const smart = useMemo(() => smartWalletSet(lb ?? []), [lb]);

  const rows = useMemo(
    () => trades.filter((t) => t.size * t.price >= minUsd).slice(0, 120),
    [trades, minUsd],
  );

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">LIVE ACTIVITY</h1>
        <span className="mono-num text-[10px] text-faint">
          {trades.length} FILLS BUFFERED · POLLING ≤12S
        </span>
        <div className="flex-1" />
        <span className="label-faint">MIN NOTIONAL</span>
        <div className="flex gap-px bg-line">
          {[0, 500, 2_000, 10_000].map((v) => (
            <button
              key={v}
              onClick={() => setMinUsd(v)}
              className={cx(
                "focus-outline h-7 px-2.5 text-[10px] font-medium tracking-[0.08em] transition-colors",
                minUsd === v ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
              )}
            >
              {v === 0 ? "ALL" : fmt.usd(v)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-px bg-line p-px">
        <Panel className="col-span-3 border-0" title="NETWORK INTELLIGENCE GRAPH — WALLET ⇄ MARKET FLOW" pad={false}>
          {trades.length < 20 ? (
            <Loading label="ASSEMBLING GRAPH" className="h-[560px]" />
          ) : (
            <NetworkGraph trades={trades} smartWallets={smart} height={560} />
          )}
        </Panel>

        <Panel className="col-span-2 border-0" title="EXECUTION TAPE" pad={false}>
          {!rows.length ? (
            <Loading label="READING TAPE" />
          ) : (
            <div className="flex max-h-[560px] flex-col overflow-y-auto">
              {rows.map((t) => {
                const isSmart = smart.has(t.proxyWallet.toLowerCase());
                const usd = t.size * t.price;
                return (
                  <div
                    key={`${t.transactionHash}${t.asset}${t.proxyWallet}`}
                    className={cx("hairline-b flex items-center gap-2 px-3 py-[7px]", isSmart && "bg-accent/[0.04]")}
                  >
                    <span className="mono-num w-9 shrink-0 text-[9px] text-faint">{fmt.utcClock(t.timestamp)}</span>
                    <span className={cx("w-7 shrink-0 text-[9px] font-semibold", t.side === "BUY" ? "text-pos" : "text-neg")}>
                      {t.side}
                    </span>
                    <Link
                      to={`/market/${t.slug}`}
                      className="min-w-0 flex-1 truncate text-[10.5px] text-dim hover:text-text"
                    >
                      {t.title}
                    </Link>
                    <Link
                      to={`/wallet/${t.proxyWallet.toLowerCase()}`}
                      className={cx("mono-num shrink-0 text-[9.5px] hover:text-accent2", isSmart ? "text-accent2" : "text-faint")}
                    >
                      {t.name || t.pseudonym || fmt.shortAddr(t.proxyWallet)}
                    </Link>
                    {isSmart && <Tag tone="accent">T1</Tag>}
                    <span className={cx("mono-num w-[54px] shrink-0 text-right text-[10.5px]", usd >= 10_000 ? "text-warn" : "text-text")}>
                      {fmt.usd(usd)}
                    </span>
                    <TxLink hash={t.transactionHash} />
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
