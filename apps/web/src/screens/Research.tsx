import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { normalizeMarket, fmt } from "@sentry-app/polymarket";
import { useEvents } from "../lib/queries";
import { Panel, Delta, Loading, cx } from "../components/ui/primitives";

/** RESEARCH BRIEFINGS — system-compiled event dossiers from live market structure. */
export function Research() {
  const { data: events, isLoading } = useEvents({ limit: 24 }, 120_000);
  const navigate = useNavigate();

  const briefings = useMemo(() => {
    if (!events) return [];
    return events
      .filter((ev) => (ev.markets?.length ?? 0) >= 2)
      .slice(0, 12)
      .map((ev) => {
        const markets = (ev.markets ?? [])
          .map((m) => normalizeMarket(m, ev))
          .filter((m) => m.active && !m.closed)
          .sort((a, b) => b.probability - a.probability);
        const leader = markets[0];
        const movers = [...markets].sort((a, b) => Math.abs(b.delta24h) - Math.abs(a.delta24h));
        const contested =
          markets.length >= 2 && leader && markets[1]
            ? leader.probability - markets[1].probability < 0.12
            : false;
        return { ev, markets, leader, topMover: movers[0], contested };
      })
      .filter((b) => b.leader);
  }, [events]);

  if (isLoading) return <Loading label="COMPILING BRIEFINGS" className="h-60" />;

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">MARKET BRIEFINGS</h1>
        <span className="label-faint">SYSTEM-COMPILED FROM LIVE MARKET STRUCTURE</span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-line p-px">
        {briefings.map(({ ev, markets, leader, topMover, contested }) => (
          <Panel key={ev.id} className="border-0" title={ev.title.toUpperCase()} pad={false}>
            <div className="px-3 py-2.5">
              <p className="text-[11.5px] leading-relaxed text-dim">
                {markets.length} active outcomes · {fmt.usd(ev.volume24hr ?? 0)} traded 24h ·{" "}
                {fmt.usd(ev.liquidity ?? 0)} open liquidity.{" "}
                Consensus leader: <span className="text-text">{leader.groupItemTitle || leader.question}</span> at{" "}
                <span className="mono-num text-accent2">{fmt.pct(leader.probability)}</span>
                {contested && <span className="text-warn"> — CONTESTED FIELD</span>}.
                {topMover && Math.abs(topMover.delta24h) > 0.01 && (
                  <>
                    {" "}Sharpest 24h repricing: {topMover.groupItemTitle || topMover.question} (
                    <Delta value={topMover.delta24h} suffix="pp" />
                    ).
                  </>
                )}
              </p>
            </div>
            <div className="hairline-t">
              {markets.slice(0, 5).map((m) => (
                <button
                  key={m.id}
                  onClick={() => navigate(`/market/${m.slug}`)}
                  className="hairline-b row-hover flex w-full items-center gap-2 px-3 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text">
                    {m.groupItemTitle || m.question}
                  </span>
                  <div className="h-[3px] w-24 bg-raise3">
                    <div className="h-full bg-accent/70" style={{ width: `${m.probability * 100}%` }} />
                  </div>
                  <span className="mono-num w-12 text-right text-[11px] text-accent2">{fmt.pct(m.probability)}</span>
                  <span className="w-12 text-right text-[10px]"><Delta value={m.delta24h} /></span>
                </button>
              ))}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
