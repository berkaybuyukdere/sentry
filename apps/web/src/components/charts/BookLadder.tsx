import { useMemo } from "react";
import { bookStats, fmt, type OrderBook } from "@sentry-app/polymarket";
import { cx } from "../ui/primitives";

/** Order book ladder — top levels each side with executable depth bars. */
export function BookLadder({ book, levels = 7 }: { book: OrderBook; levels?: number }) {
  const s = useMemo(() => bookStats(book), [book]);
  const asks = s.asks.slice(0, levels).reverse();
  const bids = s.bids.slice(0, levels);
  const maxSize = Math.max(...asks.map((l) => l.size), ...bids.map((l) => l.size), 1);

  const Row = ({ price, size, side }: { price: number; size: number; side: "bid" | "ask" }) => (
    <div className="relative flex h-[19px] items-center justify-between px-2">
      <span
        className={cx("absolute inset-y-[2px] right-0", side === "bid" ? "bg-pos/10" : "bg-neg/10")}
        style={{ width: `${(size / maxSize) * 100}%` }}
      />
      <span className={cx("mono-num relative text-[10.5px]", side === "bid" ? "text-pos" : "text-neg")}>
        {(price * 100).toFixed(1)}¢
      </span>
      <span className="mono-num relative text-[10.5px] text-dim">{fmt.num(size)}</span>
    </div>
  );

  const spread = s.bestAsk !== null && s.bestBid !== null ? s.bestAsk - s.bestBid : null;

  return (
    <div className="flex flex-col">
      <div className="flex justify-between px-2 pb-1">
        <span className="label-faint">PRICE</span>
        <span className="label-faint">SIZE</span>
      </div>
      {asks.map((l, i) => (
        <Row key={`a${i}`} price={l.price} size={l.size} side="ask" />
      ))}
      <div className="hairline-t hairline-b my-0.5 flex h-[22px] items-center justify-between px-2">
        <span className="label-faint">SPREAD</span>
        <span className="mono-num text-[10px] text-text">
          {spread !== null ? `${(spread * 100).toFixed(1)}¢` : "—"}
        </span>
        <span
          className={cx(
            "mono-num text-[10px]",
            s.imbalance > 0.1 ? "text-pos" : s.imbalance < -0.1 ? "text-neg" : "text-faint",
          )}
          title="Executable depth imbalance"
        >
          IMB {(s.imbalance * 100).toFixed(0)}%
        </span>
      </div>
      {bids.map((l, i) => (
        <Row key={`b${i}`} price={l.price} size={l.size} side="bid" />
      ))}
    </div>
  );
}
