import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { fmt } from "@sentry-app/polymarket";
import { useMarkets } from "../lib/queries";
import { Loading, Delta, cx } from "../components/ui/primitives";

/** EVENT TIMELINE — resolution calendar for tracked markets, nearest first. */
export function Timeline() {
  const { data: markets, isLoading } = useMarkets({ limit: 400 }, 60_000);
  const navigate = useNavigate();

  const groups = useMemo(() => {
    if (!markets) return [];
    const withDays = markets
      .map((m) => ({ m, days: fmt.daysUntil(m.endDate) }))
      .filter((x): x is { m: (typeof markets)[number]; days: number } => x.days !== null && x.days >= 0 && x.m.volume24h > 1000)
      .sort((a, b) => a.days - b.days);
    const buckets: { label: string; test: (d: number) => boolean }[] = [
      { label: "RESOLVING ≤ 24H", test: (d) => d <= 1 },
      { label: "THIS WEEK", test: (d) => d <= 7 },
      { label: "THIS MONTH", test: (d) => d <= 30 },
      { label: "THIS QUARTER", test: (d) => d <= 90 },
      { label: "BEYOND", test: () => true },
    ];
    const used = new Set<string>();
    return buckets
      .map((b) => ({
        label: b.label,
        rows: withDays.filter((x) => {
          if (used.has(x.m.id) || !b.test(x.days)) return false;
          used.add(x.m.id);
          return true;
        }).slice(0, 14),
      }))
      .filter((g) => g.rows.length);
  }, [markets]);

  if (isLoading) return <Loading label="BUILDING RESOLUTION CALENDAR" className="h-60" />;

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">EVENT TIMELINE</h1>
        <span className="label-faint">RESOLUTION HORIZON · VOLUME-QUALIFIED MARKETS</span>
      </div>
      <div className="flex flex-col">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="hairline-b sticky top-0 z-10 flex h-8 items-center gap-2 bg-bg px-4">
              <span className="size-1 bg-accent" />
              <span className="label">{g.label}</span>
              <span className="mono-num text-[9px] text-faint">{g.rows.length}</span>
            </div>
            {g.rows.map(({ m, days }) => (
              <button
                key={m.id}
                onClick={() => navigate(`/market/${m.slug}`)}
                className="hairline-b row-hover flex w-full items-center gap-3 px-4 py-2 text-left"
              >
                <span className="mono-num w-16 shrink-0 text-[10px] text-warn">T−{days}D</span>
                <span className="mono-num w-[74px] shrink-0 text-[10px] text-faint">{fmt.utcDate(m.endDate)}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{m.question}</span>
                <span className="mono-num w-12 shrink-0 text-right text-[11.5px] text-accent2">
                  {fmt.pct(m.probability)}
                </span>
                <span className="w-14 shrink-0 text-right text-[10.5px]"><Delta value={m.delta24h} suffix="pp" /></span>
                <span className="mono-num w-16 shrink-0 text-right text-[10px] text-faint">{fmt.usd(m.volume24h)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
