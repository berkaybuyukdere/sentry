import { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Eye, BellPlus } from "lucide-react";
import {
  fmt,
  normalizeMarket,
  type HistoryInterval,
  type Market,
} from "@sentry-app/polymarket";
import {
  useMarket,
  usePriceHistory,
  useOrderBook,
  useMarketTrades,
  useHolders,
  useEventBySlug,
} from "../lib/queries";
import { useLiveTokens, useQuote } from "../lib/prices";
import { useTicket } from "../components/market/ticket";
import { useWatchPicker } from "../components/market/WatchlistPicker";
import { ProbabilityChart } from "../components/charts/ProbabilityChart";
import { BookLadder } from "../components/charts/BookLadder";
import { Panel, Btn, Tag, Delta, Loading, Empty, LiveNum, Addr, cx } from "../components/ui/primitives";
import { PmMarketLink, TxLink } from "../components/ui/ExtLink";

const INTERVALS: { key: HistoryInterval; label: string; fidelity?: number }[] = [
  { key: "1h", label: "1H", fidelity: 1 },
  { key: "6h", label: "6H", fidelity: 5 },
  { key: "1d", label: "1D", fidelity: 10 },
  { key: "1w", label: "7D", fidelity: 60 },
  { key: "1m", label: "30D", fidelity: 180 },
  { key: "max", label: "ALL", fidelity: 720 },
];

export function MarketDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data: market, isLoading } = useMarket(slug);
  const [interval, setInterval_] = useState<(typeof INTERVALS)[number]>(INTERVALS[2]);
  const [outcomeIdx, setOutcomeIdx] = useState(0);

  const tokenId = market?.clobTokenIds[outcomeIdx];
  useLiveTokens(tokenId ? [tokenId] : []);
  const quote = useQuote(tokenId);
  const { data: history, isLoading: histLoading } = usePriceHistory(tokenId, interval.key, interval.fidelity);
  const { data: book } = useOrderBook(tokenId);
  const { data: tape } = useMarketTrades(market?.conditionId, 80);
  const { data: holders } = useHolders(market?.conditionId);
  const { data: event } = useEventBySlug(market?.eventSlug ?? undefined);

  const stage = useTicket((s) => s.stage);
  const openPicker = useWatchPicker((s) => s.openMarket);
  const navigate = useNavigate();

  if (isLoading) return <Loading label="RETRIEVING MARKET FILE" className="h-60" />;
  if (!market)
    return <Empty label="MARKET NOT FOUND" hint="The instrument may have been delisted or resolved." />;

  const liveProb = outcomeIdx === 0 ? (quote?.last ?? market.probability) : (quote?.last ?? market.outcomePrices[outcomeIdx] ?? 0);
  const days = fmt.daysUntil(market.endDate);

  return (
    <div className="flex flex-col">
      {/* header */}
      <div className="hairline-b px-4 py-3">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              {market.tags.slice(0, 3).map((t) => (
                <span key={t} className="label-faint">{t}</span>
              ))}
              <span className="mono-num text-[9px] text-faint">ID {market.conditionId.slice(0, 10)}…</span>
              <PmMarketLink eventSlug={market.eventSlug} marketSlug={market.slug} />
              {market.negRisk && <Tag>NEG-RISK</Tag>}
              <Tag tone={market.acceptingOrders ? "pos" : "warn"}>
                {market.acceptingOrders ? "ACCEPTING ORDERS" : "HALTED"}
              </Tag>
            </div>
            <h1 className="flex items-center gap-2.5 text-[17px] font-medium leading-snug text-text">
              {market.image && (
                <img src={market.image} alt="" className="size-7 shrink-0 border border-line object-cover" />
              )}
              {market.question}
            </h1>
            <div className="mono-num mt-1.5 flex items-center gap-4 text-[10.5px] text-dim">
              <span>VOL {fmt.usd(market.volume)}</span>
              <span>24H {fmt.usd(market.volume24h)}</span>
              <span>LIQ {fmt.usd(market.liquidity)}</span>
              <span>
                CLOSES {fmt.utcDate(market.endDate)}
                {days !== null && days >= 0 && <span className="text-faint"> · T−{days}D</span>}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex items-baseline gap-3">
              <LiveNum value={liveProb} format={(v) => fmt.pct(v)} className="text-[28px] font-medium leading-none text-accent2" />
              <div className="flex flex-col text-right text-[11px]">
                <Delta value={market.delta1h} suffix="pp 1H" />
                <Delta value={market.delta24h} suffix="pp 24H" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Btn variant="yes" size="lg" onClick={() => stage(market, 0, "BUY")}>
                BUY {market.outcomes[0]?.toUpperCase() ?? "YES"} {fmt.cents(market.outcomePrices[0] ?? 0)}
              </Btn>
              <Btn variant="no" size="lg" onClick={() => stage(market, 1, "BUY")}>
                BUY {market.outcomes[1]?.toUpperCase() ?? "NO"} {fmt.cents(market.outcomePrices[1] ?? 0)}
              </Btn>
              <Btn size="lg" onClick={() => openPicker(market)}>
                <Eye size={12} strokeWidth={1.5} /> WATCH
              </Btn>
              <Btn size="lg" onClick={() => navigate(`/rules?market=${market.slug}&title=${encodeURIComponent(market.question)}`)}>
                <BellPlus size={12} strokeWidth={1.5} /> ALERT
              </Btn>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-line p-px">
        {/* chart */}
        <Panel
          className="col-span-2 border-0"
          title={`PROBABILITY — ${market.outcomes[outcomeIdx]?.toUpperCase() ?? ""}`}
          pad={false}
          right={
            <div className="flex items-center gap-2">
              {market.outcomes.length > 1 && (
                <div className="flex gap-px bg-line">
                  {market.outcomes.map((o, i) => (
                    <button
                      key={o}
                      onClick={() => setOutcomeIdx(i)}
                      className={cx(
                        "focus-outline h-5 px-2 text-[9px] font-medium tracking-[0.1em] transition-colors",
                        outcomeIdx === i ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
                      )}
                    >
                      {o.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-px bg-line">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv.key}
                    onClick={() => setInterval_(iv)}
                    className={cx(
                      "focus-outline h-5 px-2 text-[9px] font-medium tracking-[0.1em] transition-colors",
                      interval.key === iv.key ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
                    )}
                  >
                    {iv.label}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          {histLoading || !history ? (
            <Loading label="RETRIEVING SERIES" className="h-[320px]" />
          ) : (
            <div className="px-1 pt-2">
              <ProbabilityChart history={history} tapeMarks={tape ?? []} height={320} />
            </div>
          )}
          <div className="hairline-t flex items-center justify-between px-3 py-1.5">
            <span className="label-faint">▲▼ MARKS = FILLS ≥ $2K ON TAPE</span>
            <span className="label-faint">SOURCE — POLYMARKET CLOB</span>
          </div>
        </Panel>

        {/* book */}
        <Panel className="border-0" title="ORDER BOOK" pad={false}>
          {book ? (
            <div className="p-2"><BookLadder book={book} /></div>
          ) : (
            <Loading label="RETRIEVING BOOK" />
          )}
        </Panel>

        {/* market intelligence */}
        <Panel className="border-0" title="MARKET INTELLIGENCE — SYSTEM ASSESSMENT">
          <IntelSummary market={market} tape={tape ?? []} />
        </Panel>

        {/* smart money positioning */}
        <Panel className="border-0" title="SMART MONEY POSITIONING" pad={false}>
          <HoldersBlock market={market} holdersData={holders} />
        </Panel>

        {/* live tape */}
        <Panel className="border-0" title="EXECUTION TAPE" pad={false}>
          {!tape?.length ? (
            <Empty label="NO RECENT FILLS" />
          ) : (
            <div className="flex max-h-[300px] flex-col overflow-y-auto">
              {tape.slice(0, 30).map((t) => (
                <div
                  key={`${t.transactionHash}${t.asset}${t.timestamp}`}
                  className="hairline-b row-hover flex items-center gap-2 px-3 py-[6px]"
                >
                  <span className={cx("w-7 text-[9px] font-semibold tracking-[0.08em]", t.side === "BUY" ? "text-pos" : "text-neg")}>
                    {t.side}
                  </span>
                  <span className="w-8 truncate text-[10px] text-dim">{t.outcome}</span>
                  <Link
                    to={`/wallet/${t.proxyWallet.toLowerCase()}`}
                    className="min-w-0 flex-1 truncate text-[10px] text-faint hover:text-accent2"
                  >
                    {t.name || t.pseudonym || fmt.shortAddr(t.proxyWallet)}
                  </Link>
                  <span className="mono-num text-[10px] text-faint">{(t.price * 100).toFixed(1)}¢</span>
                  <span className="mono-num w-[52px] text-right text-[10.5px] text-text">{fmt.usd(t.size * t.price)}</span>
                  <TxLink hash={t.transactionHash} />
                  <span className="mono-num w-7 text-right text-[9px] text-faint">{fmt.timeAgo(t.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* related markets */}
        <Panel className="col-span-3 border-0" title="RELATED MARKETS — ECOSYSTEM" pad={false}>
          <RelatedMarkets current={market} eventMarkets={event?.markets ?? []} eventTitle={event?.title} />
        </Panel>
      </div>
    </div>
  );
}

/** Real, observed-data assessment: dominant flow, clustering, response. */
function IntelSummary({ market, tape }: { market: Market; tape: { side: "BUY" | "SELL"; outcome: string; size: number; price: number; timestamp: number; proxyWallet: string }[] }) {
  const analysis = useMemo(() => {
    if (!tape.length) return null;
    const now = Math.floor(Date.now() / 1000);
    const hour = tape.filter((t) => now - t.timestamp <= 3600);
    const set = hour.length >= 5 ? hour : tape;
    const buys = set.filter((t) => t.side === "BUY");
    const sells = set.filter((t) => t.side === "SELL");
    const buyUsd = buys.reduce((s, t) => s + t.size * t.price, 0);
    const sellUsd = sells.reduce((s, t) => s + t.size * t.price, 0);
    const largest = [...set].sort((a, b) => b.size * b.price - a.size * a.price)[0];
    const wallets = new Set(set.map((t) => t.proxyWallet)).size;
    const spanMin = set.length > 1 ? Math.max(1, Math.round((set[0].timestamp - set[set.length - 1].timestamp) / 60)) : 0;
    return { buyUsd, sellUsd, largest, wallets, fills: set.length, spanMin };
  }, [tape]);

  if (!analysis) return <Empty label="INSUFFICIENT TAPE" hint="Assessment builds as fills arrive." />;

  const { buyUsd, sellUsd, largest, wallets, fills, spanMin } = analysis;
  const bias = buyUsd + sellUsd > 0 ? (buyUsd - sellUsd) / (buyUsd + sellUsd) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="label mb-1 text-accent2">PRIMARY FLOW</div>
        <p className="text-[11.5px] leading-relaxed text-dim">
          {fills} fills from {wallets} distinct wallets over the last ~{spanMin}m.
          Net tape bias{" "}
          <span className={bias >= 0 ? "text-pos" : "text-neg"}>
            {bias >= 0 ? "toward" : "against"} {market.outcomes[0] ?? "YES"} ({fmt.pct(Math.abs(bias), 0)} skew)
          </span>{" "}
          on {fmt.usd(buyUsd + sellUsd)} traded.
        </p>
      </div>
      <div>
        <div className="label mb-1 text-accent2">DOMINANT PRINT</div>
        <p className="text-[11.5px] leading-relaxed text-dim">
          Largest observed fill: {largest.side} {largest.outcome} — {fmt.usd(largest.size * largest.price)} at{" "}
          {(largest.price * 100).toFixed(1)}¢ ({fmt.utcClock(largest.timestamp)} UTC).
        </p>
      </div>
      <div>
        <div className="label mb-1 text-accent2">MARKET RESPONSE</div>
        <p className="text-[11.5px] leading-relaxed text-dim">
          Probability moved <Delta value={market.delta1h} suffix="pp" /> over the last hour and{" "}
          <Delta value={market.delta24h} suffix="pp" /> over 24h. 24h volume equals{" "}
          {(market.volume24h / Math.max(market.liquidity, 1)).toFixed(1)}× the open book.
        </p>
      </div>
      <div className="hairline-t pt-2">
        <span className="label-faint">DERIVED FROM OBSERVED EXECUTION DATA ONLY</span>
      </div>
    </div>
  );
}

function HoldersBlock({
  market,
  holdersData,
}: {
  market: Market;
  holdersData?: { token: string; holders: { proxyWallet: string; amount: number; name?: string; pseudonym?: string; outcomeIndex: number }[] }[];
}) {
  if (!holdersData?.length) return <Loading label="RESOLVING HOLDERS" />;
  const yesTok = market.clobTokenIds[0];
  const yes = holdersData.find((h) => h.token === yesTok)?.holders ?? [];
  const no = holdersData.find((h) => h.token !== yesTok)?.holders ?? [];
  const yesVal = yes.reduce((s, h) => s + h.amount, 0) * (market.outcomePrices[0] ?? 0);
  const noVal = no.reduce((s, h) => s + h.amount, 0) * (market.outcomePrices[1] ?? 0);
  const total = yesVal + noVal || 1;

  const Col = ({ rows, label, tone }: { rows: typeof yes; label: string; tone: "pos" | "neg" }) => (
    <div className="min-w-0 flex-1">
      <div className={cx("label px-3 py-1.5", tone === "pos" ? "text-pos" : "text-neg")}>{label}</div>
      {rows.slice(0, 6).map((h) => (
        <Link
          key={h.proxyWallet}
          to={`/wallet/${h.proxyWallet.toLowerCase()}`}
          className="hairline-t row-hover flex items-center justify-between gap-2 px-3 py-1.5"
        >
          <Addr address={h.proxyWallet} name={h.name || h.pseudonym} />
          <span className="mono-num text-[10px] text-dim">{fmt.num(h.amount)} sh</span>
        </Link>
      ))}
    </div>
  );

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="label-faint">TOP-HOLDER VALUE SPLIT</span>
        <div className="relative h-[5px] flex-1 bg-raise3">
          <span className="absolute inset-y-0 left-0 bg-pos/70" style={{ width: `${(yesVal / total) * 100}%` }} />
        </div>
        <span className="mono-num text-[10px] text-pos">{fmt.pct(yesVal / total, 0)}</span>
      </div>
      <div className="hairline-t flex divide-x divide-line">
        <Col rows={yes} label={`HOLDING ${market.outcomes[0]?.toUpperCase() ?? "YES"}`} tone="pos" />
        <Col rows={no} label={`HOLDING ${market.outcomes[1]?.toUpperCase() ?? "NO"}`} tone="neg" />
      </div>
    </div>
  );
}

function RelatedMarkets({
  current,
  eventMarkets,
  eventTitle,
}: {
  current: Market;
  eventMarkets: unknown[];
  eventTitle?: string;
}) {
  const navigate = useNavigate();
  const siblings = useMemo(() => {
    return (eventMarkets as Parameters<typeof normalizeMarket>[0][])
      .map((m) => normalizeMarket(m))
      .filter((m) => m.id !== current.id && m.active && !m.closed)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 8);
  }, [eventMarkets, current.id]);

  if (!siblings.length) return <Empty label="NO LINKED INSTRUMENTS" hint="This market stands alone in its event." />;

  return (
    <div>
      {eventTitle && <div className="label-faint px-3 pt-2">{eventTitle.toUpperCase()}</div>}
      <div className="grid grid-cols-4 gap-px bg-line p-px">
        {siblings.map((m) => (
          <button
            key={m.id}
            onClick={() => navigate(`/market/${m.slug}`)}
            className="row-hover bg-raise px-3 py-2.5 text-left"
          >
            <div className="line-clamp-2 min-h-[28px] text-[11px] leading-snug text-text">
              {m.groupItemTitle || m.question}
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="mono-num text-[13px] text-accent2">{fmt.pct(m.probability)}</span>
              <Delta value={m.delta24h} suffix="pp" />
            </div>
            <div className="mono-num mt-0.5 text-[9px] text-faint">VOL {fmt.usd(m.volume24h)} 24H</div>
          </button>
        ))}
      </div>
    </div>
  );
}
