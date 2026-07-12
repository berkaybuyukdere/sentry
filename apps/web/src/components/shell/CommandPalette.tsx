import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { create } from "zustand";
import { isAddress } from "viem";
import { fmt } from "@sentry-app/polymarket";
import { useIntelSearch, useLeaderboard } from "../../lib/queries";

interface PaletteState {
  open: boolean;
  setOpen: (v: boolean) => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function useCommandK() {
  const setOpen = usePalette((s) => s.setOpen);
  return () => setOpen(true);
}

const PAGES: { label: string; to: string; keywords?: string }[] = [
  { label: "Overview — Command Center", to: "/" },
  { label: "Live Markets", to: "/markets" },
  { label: "Discover", to: "/discover" },
  { label: "Market Scanner", to: "/scanner" },
  { label: "Signals", to: "/signals" },
  { label: "Activity Stream", to: "/activity" },
  { label: "Operator Rankings", to: "/operators", keywords: "leaderboard traders top" },
  { label: "Wallet Intelligence", to: "/wallets" },
  { label: "Copy Engine", to: "/copy", keywords: "strategies mirror" },
  { label: "Positions", to: "/portfolio" },
  { label: "Treasury — Deposit / Withdraw", to: "/treasury", keywords: "funds usdc balance" },
  { label: "Orders", to: "/orders" },
  { label: "Watchlists", to: "/watchlists" },
  { label: "Rules", to: "/rules", keywords: "alerts monitoring" },
  { label: "Alerts", to: "/alerts" },
  { label: "Research Briefings", to: "/research" },
  { label: "Event Timeline", to: "/timeline" },
  { label: "AI Operations", to: "/ai", keywords: "autopilot desk bot" },
  { label: "Access Tiers — Pricing", to: "/pricing", keywords: "subscription fees upgrade" },
  { label: "Account", to: "/account" },
  { label: "Settings", to: "/settings" },
];

export function CommandPalette() {
  const { open, setOpen } = usePalette();
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { data: search } = useIntelSearch(query);
  const { data: leaderboard } = useLeaderboard("30d", 30);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!usePalette.getState().open);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  if (!open) return null;

  const go = (to: string) => {
    navigate(to);
    setOpen(false);
  };

  const q = query.trim();
  const isWallet = isAddress(q);
  const operatorHits = q.length >= 2 && leaderboard
    ? leaderboard
        .filter((e) => (e.userName || "").toLowerCase().includes(q.toLowerCase()))
        .slice(0, 4)
    : [];

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70" onClick={() => setOpen(false)}>
      <div
        className="mx-auto mt-[12vh] w-[620px] border border-line-strong bg-raise shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command layer" shouldFilter={q.length < 2 || (!search && !isWallet)}>
          <div className="hairline-b flex items-center gap-2 px-3">
            <span className="label-faint">QUERY</span>
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="markets · wallets · operators · sections"
              className="h-10 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
            />
            <kbd className="mono-num border border-line px-1 py-px text-[9px] text-faint">ESC</kbd>
          </div>
          <Command.List className="max-h-[420px] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:label-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            <Command.Empty>
              <div className="px-3 py-6 text-center text-[11px] text-faint">NO MATCHES IN INDEX</div>
            </Command.Empty>

            {isWallet && (
              <Command.Group heading="WALLET">
                <PaletteRow onSelect={() => go(`/wallet/${q.toLowerCase()}`)} value={`wallet-${q}`}>
                  <span className="mono-num text-[11px] text-accent2">{fmt.shortAddr(q)}</span>
                  <span className="text-[10px] uppercase tracking-[0.1em] text-faint">
                    OPEN INTELLIGENCE DOSSIER
                  </span>
                </PaletteRow>
              </Command.Group>
            )}

            {operatorHits.length > 0 && (
              <Command.Group heading="OPERATORS">
                {operatorHits.map((e) => (
                  <PaletteRow
                    key={e.proxyWallet}
                    value={`op-${e.proxyWallet}`}
                    onSelect={() => go(`/wallet/${e.proxyWallet.toLowerCase()}`)}
                  >
                    <span className="text-[12px] text-text">{e.userName}</span>
                    <span className="mono-num text-[10px] text-faint">{fmt.shortAddr(e.proxyWallet)}</span>
                    <span className="mono-num ml-auto text-[10px] text-pos">{fmt.usd(e.pnl, { sign: true })} 30D</span>
                  </PaletteRow>
                ))}
              </Command.Group>
            )}

            {(search?.markets.length ?? 0) > 0 && (
              <Command.Group heading="MARKETS">
                {search!.markets.slice(0, 7).map((m) => (
                  <PaletteRow key={m.id} value={`mkt-${m.id}`} onSelect={() => go(`/market/${m.slug}`)}>
                    <span className="line-clamp-1 flex-1 text-[12px] text-text">{m.question}</span>
                    <span className="mono-num text-[11px] text-accent2">{fmt.pct(m.probability)}</span>
                    <span className="mono-num text-[10px] text-faint">{fmt.usd(m.volume24h)} 24H</span>
                  </PaletteRow>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="SECTIONS">
              {PAGES.map((p) => (
                <PaletteRow key={p.to} value={`${p.label} ${p.keywords ?? ""}`} onSelect={() => go(p.to)}>
                  <span className="text-[12px] text-dim">{p.label}</span>
                </PaletteRow>
              ))}
            </Command.Group>
          </Command.List>
          <div className="hairline-t flex h-7 items-center gap-3 px-3">
            <span className="label-faint">↑↓ NAVIGATE</span>
            <span className="label-faint">↵ EXECUTE</span>
            <span className="ml-auto label-faint">SENTRY COMMAND LAYER</span>
          </div>
        </Command>
      </div>
    </div>,
    document.body,
  );
}

function PaletteRow({
  children,
  value,
  onSelect,
}: {
  children: React.ReactNode;
  value: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 px-2.5 py-2 data-[selected=true]:bg-accent/10 data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:-outline-offset-1 data-[selected=true]:outline-accent/60"
    >
      {children}
    </Command.Item>
  );
}
