import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  derivePulse,
  deriveNarratives,
  severityRank,
  fmt,
  type Market,
} from "@sentry-app/polymarket";
import { useMarkets, useEvents } from "../lib/queries";
import { useTape } from "../lib/tape";
import { useSignals } from "../lib/signals";
import { CapitalFlow } from "../components/charts/CapitalFlow";
import { RowActions, MarketIdent } from "../components/market/MarketRow";
import {
  Panel,
  Metric,
  Delta,
  Tag,
  Loading,
  Empty,
  severityTone,
  cx,
} from "../components/ui/primitives";

type VelocityWindow = "1H" | "24H" | "7D";

export function CommandCenter() {
  const { data: markets, isLoading } = useMarkets({ limit: 300 }, 30_000);
  const { data: events } = useEvents({ limit: 80 }, 90_000);
  const trades = useTape((s) => s.trades);
  const signals = useSignals((s) => s.signals);
  const navigate = useNavigate();
  const [win, setWin] = useState<VelocityWindow>("1H");

  const pulse = useMemo(() => (markets ? derivePulse(markets) : null), [markets]);
  const narratives = useMemo(() => (events ? deriveNarratives(events).slice(0, 8) : []), [events]);

  const velocity = useMemo(() => {
    if (!markets) return [];
    const d = (m: Market) => (win === "1H" ? m.delta1h : win === "24H" ? m.delta24h : m.delta7d);
    return [...markets]
      .filter((m) => m.volume24h > 5_000 && m.liquidity > 1_000)
      .sort((a, b) => Math.abs(d(b)) - Math.abs(d(a)))
      .slice(0, 9)
      .map((m) => ({ m, delta: d(m) }));
  }, [markets, win]);

  const anomalies = useMemo(
    () =>
      signals
        .filter((s) => ["VOLUME_ANOMALY", "PROBABILITY_ACCELERATION", "SMART_WALLET_CLUSTER", "CLUSTER_ENTRY"].includes(s.type))
        .slice(0, 5),
    [signals],
  );

  const topSignals = useMemo(
    () =>
      [...signals]
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence || b.ts - a.ts)
        .slice(0, 8),
    [signals],
  );

  return (
    <div className="flex flex-col">
      {/* GLOBAL MARKET PULSE */}
      <div className="hairline-b bg-bg px-4 py-3">
        <div className="mb-3 flex items-baseline justify-between">
          <h1 className="text-[15px] font-semibold tracking-[0.18em] text-text">COMMAND CENTER</h1>
          <span className="label-faint">GLOBAL MARKET PULSE · LIVE</span>
        </div>
        {pulse ? (
          <div className="grid grid-cols-6 gap-6">
            <Metric label="24H VOLUME" value={fmt.usd(pulse.volume24h)} sub={`${pulse.activeMarkets} tracked markets`} />
            <Metric label="OPEN LIQUIDITY" value={fmt.usd(pulse.liquidity)} sub="aggregate book depth" />
            <Metric
              label="MARKET BREADTH"
              value={fmt.pct(pulse.breadth, 0)}
              tone={pulse.breadth > 0.55 ? "pos" : pulse.breadth < 0.45 ? "neg" : undefined}
              sub="share of volume in rising markets"
            />
            <Metric label="AGITATION INDEX" value={`${pulse.agitation.toFixed(1)}pp`} sub="volume-weighted |Δ24h|" />
            <Metric label="HIGH-VELOCITY" value={pulse.highVelocity} tone="accent" sub="markets |Δ1h| ≥ 2pp" />
            <Metric
              label="ACTIVE SIGNALS"
              value={signals.length}
              tone={anomalies.length ? "warn" : undefined}
              sub={`${anomalies.length} anomaly-grade`}
            />
          </div>
        ) : (
          <Loading label="ESTABLISHING MARKET LINK" className="h-14" />
        )}
      </div>

      {/* intelligence canvas */}
      <div className="grid grid-cols-3 gap-px bg-line p-px">
        {/* MARKET VELOCITY */}
        <Panel
          className="col-span-2 border-0"
          title="MARKET VELOCITY"
          pad={false}
          right={
            <div className="flex gap-px bg-line">
              {(["1H", "24H", "7D"] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => setWin(w)}
                  className={cx(
                    "focus-outline h-5 px-2 text-[9px] font-medium tracking-[0.1em] transition-colors",
                    win === w ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
                  )}
                >
                  {w}
                </button>
              ))}
            </div>
          }
        >
          {isLoading ? (
            <Loading />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="hairline-b">
                  <th className="label-faint px-3 py-1.5 text-left font-medium">MARKET</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">PROB</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">Δ {win}</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">24H VOL</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">V/L</th>
                  <th className="w-[190px] px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {velocity.map(({ m, delta }) => (
                  <tr
                    key={m.id}
                    onClick={() => navigate(`/market/${m.slug}`)}
                    className="hairline-b group cursor-pointer row-hover"
                  >
                    <td className="max-w-0 px-3 py-2"><MarketIdent market={m} /></td>
                    <td className="mono-num px-2 py-2 text-right text-[12px] text-accent2">
                      {fmt.pct(m.probability)}
                    </td>
                    <td className="px-2 py-2 text-right text-[12px]"><Delta value={delta} suffix="pp" /></td>
                    <td className="mono-num px-2 py-2 text-right text-[11px] text-dim">{fmt.usd(m.volume24h)}</td>
                    <td className="mono-num px-2 py-2 text-right text-[11px] text-faint">
                      {(m.volume24h / Math.max(m.liquidity, 1)).toFixed(1)}×
                    </td>
                    <td className="px-2 py-2">
                      <RowActions market={m} className="opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* UNUSUAL ACTIVITY */}
        <Panel className="border-0" title="UNUSUAL ACTIVITY" pad={false}>
          {anomalies.length === 0 ? (
            <Empty label="NO ANOMALIES DETECTED" hint="Baseline behavior across tracked markets." />
          ) : (
            <div className="flex flex-col">
              {anomalies.map((s) => (
                <button
                  key={s.id}
                  onClick={() => s.marketSlug && navigate(`/market/${s.marketSlug}`)}
                  className="hairline-b row-hover px-3 py-2.5 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="mono-num text-[9px] text-faint">ANOMALY {s.id}</span>
                    <Tag tone={severityTone(s.severity)}>{s.severity}</Tag>
                  </div>
                  <div className="mt-1 line-clamp-1 text-[11.5px] text-text">{s.marketTitle}</div>
                  <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-dim">
                    {s.title} — {s.detail}
                  </div>
                  <div className="mono-num mt-1 flex justify-between text-[9px] text-faint">
                    <span>CONFIDENCE {(s.confidence * 10).toFixed(1)}/10</span>
                    <span>{fmt.timeAgo(s.ts)} AGO</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        {/* TRENDING NARRATIVES */}
        <Panel className="border-0" title="TRENDING NARRATIVES" pad={false}>
          {narratives.length === 0 ? (
            <Loading />
          ) : (
            <div className="flex flex-col">
              {narratives.map((n, i) => (
                <button
                  key={n.slug}
                  onClick={() => navigate(`/markets?narrative=${n.slug}`)}
                  className="hairline-b row-hover flex items-center gap-3 px-3 py-2 text-left"
                >
                  <span className="mono-num w-5 text-[10px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] text-text">{n.tag}</div>
                    <div className="label-faint mt-0.5">{n.events} EVENTS · {n.markets} MARKETS</div>
                  </div>
                  <div className="text-right">
                    <div className="mono-num text-[11px] text-text">{fmt.usd(n.volume24h)}</div>
                    <div className="mono-num text-[9px] text-faint">AGIT {(n.agitation * 100).toFixed(1)}pp</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        {/* TOP INTELLIGENCE SIGNALS */}
        <Panel className="border-0" title="TOP INTELLIGENCE SIGNALS" pad={false}>
          {topSignals.length === 0 ? (
            <Empty label="SIGNAL ENGINE CALIBRATING" hint="Signals derive from the live tape within minutes." />
          ) : (
            <div className="flex flex-col">
              {topSignals.map((s) => (
                <button
                  key={s.id}
                  onClick={() => navigate(s.marketSlug ? `/market/${s.marketSlug}` : "/signals")}
                  className="hairline-b row-hover px-3 py-2 text-left"
                >
                  <div className="flex items-center gap-2">
                    <Tag tone={severityTone(s.severity)}>{s.type.replaceAll("_", " ")}</Tag>
                    <span className="mono-num ml-auto text-[9px] text-faint">{fmt.timeAgo(s.ts)}</span>
                  </div>
                  <div className="mt-1 line-clamp-1 text-[11px] text-text">{s.marketTitle ?? s.title}</div>
                  <div className="mono-num mt-0.5 text-[10px] text-dim">
                    {s.usd > 0 && <span className="text-accent2">{fmt.usd(s.usd)} · </span>}
                    {s.title}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        {/* CAPITAL FLOW */}
        <Panel className="border-0" title="CAPITAL FLOW — NARRATIVE ROTATION">
          {trades.length === 0 ? <Loading label="READING TAPE" /> : <CapitalFlow trades={trades} />}
        </Panel>

        {/* LIVE TAPE */}
        <Panel className="border-0" title="LIVE TAPE — LARGEST FILLS" pad={false}>
          <LiveTapeMini />
        </Panel>
      </div>
    </div>
  );
}

function LiveTapeMini() {
  const trades = useTape((s) => s.trades);
  const navigate = useNavigate();
  const rows = useMemo(
    () =>
      [...trades]
        .sort((a, b) => b.size * b.price - a.size * a.price)
        .slice(0, 9),
    [trades],
  );
  if (!rows.length) return <Loading label="READING TAPE" />;
  return (
    <div className="flex flex-col">
      {rows.map((t) => (
        <button
          key={`${t.transactionHash}${t.asset}`}
          onClick={() => navigate(`/market/${t.slug}`)}
          className="hairline-b row-hover flex items-center gap-2.5 px-3 py-[7px] text-left"
        >
          <span className={cx("w-8 text-[9px] font-semibold tracking-[0.1em]", t.side === "BUY" ? "text-pos" : "text-neg")}>
            {t.side}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{t.title}</span>
          <span className="mono-num text-[10px] text-faint">{(t.price * 100).toFixed(1)}¢</span>
          <span className="mono-num w-[54px] text-right text-[11px] text-text">{fmt.usd(t.size * t.price)}</span>
          <span className="mono-num w-7 text-right text-[9px] text-faint">{fmt.timeAgo(t.timestamp)}</span>
        </button>
      ))}
    </div>
  );
}
