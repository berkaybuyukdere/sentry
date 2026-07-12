import { useMemo } from "react";
import { fmt, domainKeyFromTitle, type DataTrade } from "@sentry-app/polymarket";
import { cx } from "../ui/primitives";

/**
 * CAPITAL FLOW — directional net flow across narrative domains,
 * computed from the observed live tape (BUY − SELL notional).
 */
export function CapitalFlow({ trades }: { trades: DataTrade[] }) {
  const rows = useMemo(() => {
    const agg = new Map<string, { inflow: number; outflow: number }>();
    for (const t of trades) {
      const usd = t.size * t.price;
      const d = domainKeyFromTitle(t.title);
      const a = agg.get(d) ?? { inflow: 0, outflow: 0 };
      if (t.side === "BUY") a.inflow += usd;
      else a.outflow += usd;
      agg.set(d, a);
    }
    return [...agg.entries()]
      .map(([domain, a]) => ({ domain, net: a.inflow - a.outflow, gross: a.inflow + a.outflow }))
      .sort((a, b) => b.gross - a.gross);
  }, [trades]);

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.net)), 1);

  if (!rows.length) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.domain} className="flex items-center gap-2">
          <span className="label w-16 shrink-0 text-right">{r.domain.toUpperCase()}</span>
          <div className="relative h-[14px] flex-1 bg-raise2">
            <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
            <span
              className={cx("absolute inset-y-[3px]", r.net >= 0 ? "bg-pos/60" : "bg-neg/60")}
              style={
                r.net >= 0
                  ? { left: "50%", width: `${(r.net / maxAbs) * 48}%` }
                  : { right: "50%", width: `${(-r.net / maxAbs) * 48}%` }
              }
            />
          </div>
          <span className={cx("mono-num w-[70px] shrink-0 text-right text-[11px]", r.net >= 0 ? "text-pos" : "text-neg")}>
            {r.net >= 0 ? "+" : "−"}{fmt.usd(Math.abs(r.net)).slice(1)}
          </span>
        </div>
      ))}
      <div className="mt-1 flex justify-between">
        <span className="label-faint">NET TAPE FLOW · ROLLING BUFFER</span>
        <span className="label-faint">{trades.length} FILLS</span>
      </div>
    </div>
  );
}
