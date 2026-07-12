import { useNavigate } from "react-router-dom";
import { Eye, Crosshair, BellPlus, ArrowUpRight } from "lucide-react";
import { fmt, type Market } from "@sentry-app/polymarket";
import { useTicket } from "./ticket";
import { useWatchPicker } from "./WatchlistPicker";
import { cx } from "../ui/primitives";

/** Contextual action bar revealed on market-row hover: OPEN · WATCH · TRADE · ALERT */
export function RowActions({ market, className }: { market: Market; className?: string }) {
  const navigate = useNavigate();
  const stage = useTicket((s) => s.stage);
  const openPicker = useWatchPicker((s) => s.openMarket);
  const Action = ({
    label,
    icon: Icon,
    onClick,
    tone,
  }: {
    label: string;
    icon: typeof Eye;
    onClick: (e: React.MouseEvent) => void;
    tone?: "pos";
  }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cx(
        "focus-outline flex h-[22px] items-center gap-1 border border-line-strong bg-raise2 px-1.5 text-[9px] font-medium uppercase tracking-[0.1em] transition-colors hover:border-accent/60 hover:text-text",
        tone === "pos" ? "text-pos2" : "text-dim",
      )}
    >
      <Icon size={10} strokeWidth={1.5} />
      {label}
    </button>
  );
  return (
    <div className={cx("flex items-center gap-1", className)}>
      <Action label="OPEN" icon={ArrowUpRight} onClick={() => navigate(`/market/${market.slug}`)} />
      <Action label="WATCH" icon={Eye} onClick={() => openPicker(market)} />
      <Action label="TRADE" icon={Crosshair} tone="pos" onClick={() => stage(market, 0, "BUY")} />
      <Action label="ALERT" icon={BellPlus} onClick={() => navigate(`/rules?market=${market.slug}&title=${encodeURIComponent(market.question)}`)} />
    </div>
  );
}

/** Compact market identity cell: icon + question + event/category context. */
export function MarketIdent({ market, showEvent = true }: { market: Market; showEvent?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {market.image && (
        <img
          src={market.image}
          alt=""
          loading="lazy"
          className="size-[18px] shrink-0 border border-line object-cover"
        />
      )}
      <div className="min-w-0">
      <div className="truncate text-[11.5px] leading-tight text-text">{market.question}</div>
      {showEvent && (
        <div className="mt-0.5 flex items-center gap-1.5 truncate">
          {market.tags.slice(0, 2).map((t) => (
            <span key={t} className="label-faint">{t}</span>
          ))}
          {market.endDate && (
            <span className="mono-num text-[9px] text-faint">→ {fmt.utcDate(market.endDate)}</span>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
