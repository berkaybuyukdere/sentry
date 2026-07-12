import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { smartWalletSet, fmt, type Market } from "@sentry-app/polymarket";
import { useMarkets, useLeaderboard } from "../lib/queries";
import { useTape } from "../lib/tape";
import { Panel, Delta, Loading, Empty, cx } from "../components/ui/primitives";

/**
 * DISCOVER — analytically generated opportunity surfaces, all computed
 * from live observed data (no editorial curation).
 */
export function Discover() {
  const { data: markets, isLoading } = useMarkets({ limit: 400 }, 45_000);
  const { data: lb } = useLeaderboard("30d", 50);
  const trades = useTape((s) => s.trades);
  const smart = useMemo(() => smartWalletSet(lb ?? []), [lb]);

  const sections = useMemo(() => {
    if (!markets) return null;
    const eligible = markets.filter((m) => m.liquidity > 500);

    // EMERGING — young-ish markets with accelerating volume vs weekly baseline
    const emerging = eligible
      .filter((m) => m.volume1w > 0 && m.volume24h > 5_000)
      .map((m) => ({ m, accel: m.volume24h / Math.max(m.volume1w / 7, 1) }))
      .filter((x) => x.accel > 2)
      .sort((a, b) => b.accel - a.accel)
      .slice(0, 8);

    // CAPITAL INFLOW — largest absolute 24h volume relative to total historical
    const inflow = [...eligible]
      .filter((m) => m.volume > 0)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 8);

    // SMART MONEY CONSENSUS / DISAGREEMENT from tape
    const smartByMarket = new Map<string, { buy: number; sell: number; wallets: Set<string>; title: string; slug: string }>();
    for (const t of trades) {
      if (!smart.has(t.proxyWallet.toLowerCase())) continue;
      const usd = t.size * t.price;
      const e = smartByMarket.get(t.conditionId) ?? { buy: 0, sell: 0, wallets: new Set(), title: t.title, slug: t.slug };
      if (t.side === "BUY") e.buy += usd;
      else e.sell += usd;
      e.wallets.add(t.proxyWallet.toLowerCase());
      smartByMarket.set(t.conditionId, e);
    }
    const smartRows = [...smartByMarket.entries()].map(([cid, e]) => {
      const gross = e.buy + e.sell;
      return {
        cid,
        ...e,
        net: e.buy - e.sell,
        gross,
        agreement: gross > 0 ? Math.abs(e.buy - e.sell) / gross : 0,
      };
    });
    const consensus = smartRows
      .filter((r) => r.wallets.size >= 2 && r.agreement > 0.7)
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 8);
    const disagreement = smartRows
      .filter((r) => r.wallets.size >= 2 && r.agreement < 0.4)
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 8);

    // LOW ATTENTION / HIGH ACTIVITY — big velocity, modest total volume
    const lowAttention = eligible
      .filter((m) => m.volume < 500_000 && m.volume24h > 10_000)
      .map((m) => ({ m, vel: m.volume24h / Math.max(m.liquidity, 1) }))
      .sort((a, b) => b.vel - a.vel)
      .slice(0, 8);

    // CONVICTION — deep books with strong directional day moves
    const conviction = eligible
      .filter((m) => m.liquidity > 20_000 && Math.abs(m.delta24h) > 0.03)
      .sort((a, b) => Math.abs(b.delta24h) * b.liquidity - Math.abs(a.delta24h) * a.liquidity)
      .slice(0, 8);

    return { emerging, inflow, consensus, disagreement, lowAttention, conviction };
  }, [markets, trades, smart]);

  if (isLoading || !sections)
    return <Loading label="COMPILING DISCOVERY SURFACES" className="h-60" />;

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">DISCOVER</h1>
        <span className="label-faint">ANALYTICALLY GENERATED · REFRESHES WITH LIVE DATA</span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-line p-px">
        <MarketList
          title="EMERGING MARKETS — VOLUME ACCELERATION"
          rows={sections.emerging.map((x) => ({ m: x.m, metric: `${x.accel.toFixed(1)}× WEEKLY PACE` }))}
        />
        <MarketList
          title="CAPITAL INFLOW — LARGEST 24H"
          rows={sections.inflow.map((m) => ({ m, metric: `${fmt.usd(m.volume24h)} 24H` }))}
        />
        <TapeList title="SMART MONEY CONSENSUS — COHORT ALIGNED" rows={sections.consensus} kind="consensus" />
        <TapeList title="MARKET DISAGREEMENT — COHORT SPLIT" rows={sections.disagreement} kind="split" />
        <MarketList
          title="LOW ATTENTION / HIGH ACTIVITY"
          rows={sections.lowAttention.map((x) => ({ m: x.m, metric: `${x.vel.toFixed(1)}× BOOK TURNOVER` }))}
        />
        <MarketList
          title="CONVICTION — DEEP BOOKS, STRONG MOVES"
          rows={sections.conviction.map((m) => ({ m, metric: `LIQ ${fmt.usd(m.liquidity)}` }))}
        />
      </div>
    </div>
  );
}

function MarketList({
  title,
  rows,
}: {
  title: string;
  rows: { m: Market; metric: string }[];
}) {
  const navigate = useNavigate();
  return (
    <Panel className="border-0" title={title} pad={false}>
      {!rows.length ? (
        <Empty label="NO QUALIFIERS" hint="Thresholds not met in the current window." />
      ) : (
        <div className="flex flex-col">
          {rows.map(({ m, metric }) => (
            <button
              key={m.id}
              onClick={() => navigate(`/market/${m.slug}`)}
              className="hairline-b row-hover flex items-center gap-3 px-3 py-2 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11.5px] text-text">{m.question}</div>
                <div className="label-faint mt-0.5">{metric}</div>
              </div>
              <span className="mono-num text-[12px] text-accent2">{fmt.pct(m.probability)}</span>
              <span className="w-14 text-right text-[11px]"><Delta value={m.delta24h} suffix="pp" /></span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function TapeList({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: { cid: string; title: string; slug: string; buy: number; sell: number; net: number; gross: number; wallets: Set<string> }[];
  kind: "consensus" | "split";
}) {
  const navigate = useNavigate();
  return (
    <Panel className="border-0" title={title} pad={false}>
      {!rows.length ? (
        <Empty
          label={kind === "consensus" ? "NO ALIGNED COHORT FLOW" : "NO CONTESTED FLOW"}
          hint="Requires ≥2 leaderboard wallets active in one market on the live tape."
        />
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => (
            <button
              key={r.cid}
              onClick={() => navigate(`/market/${r.slug}`)}
              className="hairline-b row-hover px-3 py-2 text-left"
            >
              <div className="truncate text-[11.5px] text-text">{r.title}</div>
              <div className="mt-1 flex items-center gap-3">
                <span className="mono-num text-[10px] text-faint">{r.wallets.size} T1 WALLETS</span>
                <span className="mono-num text-[10px] text-pos">BUY {fmt.usd(r.buy)}</span>
                <span className="mono-num text-[10px] text-neg">SELL {fmt.usd(r.sell)}</span>
                <span
                  className={cx(
                    "mono-num ml-auto text-[10px]",
                    r.net >= 0 ? "text-pos" : "text-neg",
                  )}
                >
                  NET {r.net >= 0 ? "+" : "−"}{fmt.usd(Math.abs(r.net)).slice(1)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
