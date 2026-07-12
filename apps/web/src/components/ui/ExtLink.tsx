import { ArrowUpRight } from "lucide-react";
import { cx } from "./primitives";

/** Outbound reference chips — Polymarket surfaces + Polygonscan.
 *  Institutional chips, not logo mimicry; every chip opens a new tab. */

function Chip({
  href,
  children,
  title,
  className,
}: {
  href: string;
  children: React.ReactNode;
  title: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={cx(
        "mono-num inline-flex h-[17px] shrink-0 items-center gap-0.5 border border-line-strong px-1 text-[8.5px] tracking-[0.08em] text-faint transition-colors hover:border-accent/60 hover:text-accent2",
        className,
      )}
    >
      {children}
      <ArrowUpRight size={8} strokeWidth={1.5} />
    </a>
  );
}

/** Polymarket event/market page. */
export function PmMarketLink({ eventSlug, marketSlug, className }: { eventSlug?: string | null; marketSlug?: string; className?: string }) {
  const href = eventSlug
    ? `https://polymarket.com/event/${eventSlug}`
    : `https://polymarket.com/market/${marketSlug}`;
  if (!eventSlug && !marketSlug) return null;
  return (
    <Chip href={href} title="Open on Polymarket" className={className}>
      PM
    </Chip>
  );
}

/** Polymarket public profile for a wallet. */
export function PmProfileLink({ address, label = "PM PROFILE", className }: { address: string; label?: string; className?: string }) {
  return (
    <Chip href={`https://polymarket.com/profile/${address}`} title="Polymarket profile" className={className}>
      {label}
    </Chip>
  );
}

/** Polygonscan transaction. */
export function TxLink({ hash, className }: { hash: string; className?: string }) {
  return (
    <Chip href={`https://polygonscan.com/tx/${hash}`} title="Transaction on Polygonscan" className={className}>
      TX
    </Chip>
  );
}

/** Polygonscan address. */
export function AddrScanLink({ address, className }: { address: string; className?: string }) {
  return (
    <Chip href={`https://polygonscan.com/address/${address}`} title="Address on Polygonscan" className={className}>
      SCAN
    </Chip>
  );
}
