import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { fmt, domainKeyFromTitle, type Market } from "@sentry-app/polymarket";
import { useMarkets } from "../lib/queries";
import { useLiveTokens, useQuote } from "../lib/prices";
import { useSignals } from "../lib/signals";
import { Heatmap } from "../components/charts/Heatmap";
import { MatrixPlot } from "../components/charts/MatrixPlot";
import { RowActions, MarketIdent } from "../components/market/MarketRow";
import { Delta, Loading, LiveNum, cx } from "../components/ui/primitives";

type ViewMode = "TABLE" | "MATRIX" | "HEATMAP";
type SortKey = "volume24h" | "liquidity" | "probability" | "delta1h" | "delta24h" | "velocity" | "spread" | "signals";

const domainOf = (m: Market) => m.tags[0] ?? domainKeyFromTitle(m.question);

export function LiveMarkets({ scanner = false }: { scanner?: boolean }) {
  const [params] = useSearchParams();
  const narrative = params.get("narrative");
  const { data: markets, isLoading } = useMarkets({ limit: 400 }, 30_000);
  const signals = useSignals((s) => s.signals);
  const [mode, setMode] = useState<ViewMode>("TABLE");
  const [query, setQuery] = useState("");
  const [minVol, setMinVol] = useState(scanner ? 1000 : 0);
  const [minLiq, setMinLiq] = useState(0);
  const [probRange, setProbRange] = useState<[number, number]>([0, 100]);
  const [maxDays, setMaxDays] = useState<number | null>(null);
  const [onlySignals, setOnlySignals] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(scanner);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "volume24h", dir: -1 });

  const signalCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of signals) {
      if (s.conditionId) map.set(s.conditionId, (map.get(s.conditionId) ?? 0) + 1);
    }
    return map;
  }, [signals]);

  const rows = useMemo(() => {
    if (!markets) return [];
    const q = query.trim().toLowerCase();
    const val = (m: Market): number => {
      switch (sort.key) {
        case "velocity":
          return m.volume24h / Math.max(m.liquidity, 1);
        case "signals":
          return signalCount.get(m.conditionId) ?? 0;
        case "spread":
          return m.spread ?? 0;
        default:
          return Math.abs(m[sort.key] as number);
      }
    };
    return markets
      .filter((m) => {
        if (q && !m.question.toLowerCase().includes(q) && !(m.eventTitle ?? "").toLowerCase().includes(q)) return false;
        if (narrative && !m.tags.some((t) => t.toLowerCase().replaceAll(" ", "-") === narrative)) return false;
        if (m.volume24h < minVol || m.liquidity < minLiq) return false;
        const p = m.probability * 100;
        if (p < probRange[0] || p > probRange[1]) return false;
        if (maxDays !== null) {
          const d = fmt.daysUntil(m.endDate);
          if (d === null || d > maxDays) return false;
        }
        if (onlySignals && !(signalCount.get(m.conditionId) ?? 0)) return false;
        return true;
      })
      .sort((a, b) => (val(b) - val(a)) * (sort.dir === -1 ? 1 : -1));
  }, [markets, query, narrative, minVol, minLiq, probRange, maxDays, onlySignals, sort, signalCount]);

  // live quotes for the visible universe (primary outcome tokens)
  const tokenIds = useMemo(() => rows.slice(0, 250).map((m) => m.clobTokenIds[0]).filter(Boolean), [rows]);
  useLiveTokens(tokenIds);

  const th = (label: string, key?: SortKey, align: "left" | "right" = "right") => (
    <th
      className={cx(
        "label-faint select-none px-2 py-1.5 font-medium",
        align === "left" ? "text-left" : "text-right",
        key && "cursor-pointer hover:text-dim",
      )}
      onClick={key ? () => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : -1 })) : undefined}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {key && sort.key === key && (sort.dir === -1 ? <ChevronDown size={9} /> : <ChevronUp size={9} />)}
      </span>
    </th>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="hairline-b flex h-11 shrink-0 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">
          {scanner ? "MARKET SCANNER" : "LIVE MARKETS"}
        </h1>
        {narrative && (
          <span className="label border border-accent/40 px-1.5 py-0.5 text-accent2">
            NARRATIVE: {narrative.toUpperCase()}
          </span>
        )}
        <span className="mono-num text-[10px] text-faint">{rows.length} INSTRUMENTS</span>
        <div className="flex-1" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="FILTER UNIVERSE"
          className="focus-outline h-7 w-[200px] border border-line bg-raise px-2.5 text-[11px] text-text placeholder:text-faint"
        />
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className={cx(
            "focus-outline flex h-7 items-center gap-1.5 border px-2 text-[10px] uppercase tracking-[0.1em] transition-colors",
            filtersOpen ? "border-accent/60 text-accent2" : "border-line text-dim hover:border-line-strong",
          )}
        >
          <SlidersHorizontal size={11} strokeWidth={1.5} /> FILTERS
        </button>
        <div className="flex gap-px bg-line">
          {(["TABLE", "MATRIX", "HEATMAP"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx(
                "focus-outline h-7 px-2.5 text-[10px] font-medium tracking-[0.12em] transition-colors",
                mode === m ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {filtersOpen && (
        <div className="hairline-b flex flex-wrap items-end gap-5 bg-raise px-4 py-2.5">
          <FilterNum label="MIN 24H VOLUME" value={minVol} onChange={setMinVol} step={5000} />
          <FilterNum label="MIN LIQUIDITY" value={minLiq} onChange={setMinLiq} step={2500} />
          <div>
            <div className="label-faint mb-1">PROBABILITY RANGE</div>
            <div className="flex items-center gap-1.5">
              <input
                type="number" min={0} max={100} value={probRange[0]}
                onChange={(e) => setProbRange([Number(e.target.value), probRange[1]])}
                className="focus-outline mono-num h-6 w-14 border border-line bg-raise2 px-1.5 text-[11px] text-text"
              />
              <span className="text-faint">—</span>
              <input
                type="number" min={0} max={100} value={probRange[1]}
                onChange={(e) => setProbRange([probRange[0], Number(e.target.value)])}
                className="focus-outline mono-num h-6 w-14 border border-line bg-raise2 px-1.5 text-[11px] text-text"
              />
            </div>
          </div>
          <div>
            <div className="label-faint mb-1">RESOLVES WITHIN</div>
            <div className="flex gap-px bg-line">
              {([null, 7, 30, 90] as const).map((d) => (
                <button
                  key={String(d)}
                  onClick={() => setMaxDays(d)}
                  className={cx(
                    "focus-outline h-6 px-2 text-[10px] transition-colors",
                    maxDays === d ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {d === null ? "ANY" : `${d}D`}
                </button>
              ))}
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-1">
            <input
              type="checkbox"
              checked={onlySignals}
              onChange={(e) => setOnlySignals(e.target.checked)}
              className="size-3 appearance-none border border-line-strong bg-raise2 checked:border-accent checked:bg-accent/40"
            />
            <span className="label">ACTIVE SIGNALS ONLY</span>
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {isLoading ? (
          <Loading label="ESTABLISHING MARKET LINK" className="h-40" />
        ) : mode === "HEATMAP" ? (
          <div className="p-px"><Heatmap markets={rows} groupBy={domainOf} height={640} /></div>
        ) : mode === "MATRIX" ? (
          <div className="p-px"><MatrixPlot markets={rows} height={640} /></div>
        ) : (
          <VirtualTable rows={rows} signalCount={signalCount} th={th} />
        )}
      </div>
    </div>
  );
}

function FilterNum({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step: number }) {
  return (
    <div>
      <div className="label-faint mb-1">{label}</div>
      <input
        type="number" min={0} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="focus-outline mono-num h-6 w-24 border border-line bg-raise2 px-1.5 text-[11px] text-text"
      />
    </div>
  );
}

function VirtualTable({
  rows,
  signalCount,
  th,
}: {
  rows: Market[];
  signalCount: Map<string, number>;
  th: (label: string, key?: SortKey, align?: "left" | "right") => React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 14,
  });

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <table className="w-full table-fixed">
        <colgroup>
          <col />
          <col className="w-[74px]" />
          <col className="w-[100px]" />
          <col className="w-[72px]" />
          <col className="w-[72px]" />
          <col className="w-[84px]" />
          <col className="w-[84px]" />
          <col className="w-[56px]" />
          <col className="w-[58px]" />
          <col className="w-[46px]" />
          <col className="w-[196px]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-bg">
          <tr className="hairline-b">
            {th("MARKET", undefined, "left")}
            {th("PROB", "probability")}
            {th("BID / ASK")}
            {th("Δ 1H", "delta1h")}
            {th("Δ 24H", "delta24h")}
            {th("24H VOL", "volume24h")}
            {th("LIQUIDITY", "liquidity")}
            {th("V/L", "velocity")}
            {th("SPREAD", "spread")}
            {th("SIG", "signals")}
            <th />
          </tr>
        </thead>
        <tbody>
          {virtualizer.getVirtualItems().length > 0 && (
            <tr style={{ height: virtualizer.getVirtualItems()[0].start }} />
          )}
          {virtualizer.getVirtualItems().map((vi) => {
            const m = rows[vi.index];
            return <MarketTr key={m.id} market={m} signals={signalCount.get(m.conditionId) ?? 0} />;
          })}
          <tr
            style={{
              height:
                virtualizer.getTotalSize() -
                (virtualizer.getVirtualItems().at(-1)?.end ?? 0),
            }}
          />
        </tbody>
      </table>
    </div>
  );
}

function MarketTr({ market: m, signals }: { market: Market; signals: number }) {
  const navigate = useNavigate();
  const quote = useQuote(m.clobTokenIds[0]);
  const prob = quote?.last ?? m.probability;
  const bid = quote?.bid ?? m.bestBid;
  const ask = quote?.ask ?? m.bestAsk;
  return (
    <tr
      onClick={() => navigate(`/market/${m.slug}`)}
      className="hairline-b group h-10 cursor-pointer row-hover"
    >
      <td className="max-w-0 px-3"><MarketIdent market={m} /></td>
      <td className="px-2 text-right">
        <LiveNum value={prob} format={(v) => fmt.pct(v)} className="text-[12px] text-accent2" />
      </td>
      <td className="mono-num px-2 text-right text-[10.5px] text-dim">
        {bid != null ? (bid * 100).toFixed(1) : "—"}
        <span className="text-faint"> / </span>
        {ask != null ? (ask * 100).toFixed(1) : "—"}
      </td>
      <td className="px-2 text-right text-[11px]"><Delta value={m.delta1h} /></td>
      <td className="px-2 text-right text-[11px]"><Delta value={m.delta24h} /></td>
      <td className="mono-num px-2 text-right text-[11px] text-dim">{fmt.usd(m.volume24h)}</td>
      <td className="mono-num px-2 text-right text-[11px] text-faint">{fmt.usd(m.liquidity)}</td>
      <td className="mono-num px-2 text-right text-[10.5px] text-faint">
        {(m.volume24h / Math.max(m.liquidity, 1)).toFixed(1)}×
      </td>
      <td className="mono-num px-2 text-right text-[10.5px] text-faint">
        {m.spread != null ? `${(m.spread * 100).toFixed(1)}¢` : "—"}
      </td>
      <td className="px-2 text-right">
        {signals > 0 && (
          <span className="mono-num inline-flex h-4 min-w-4 items-center justify-center border border-warn/50 px-1 text-[9px] text-warn2">
            {signals}
          </span>
        )}
      </td>
      <td className="px-2">
        <RowActions market={m} className="justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      </td>
    </tr>
  );
}
