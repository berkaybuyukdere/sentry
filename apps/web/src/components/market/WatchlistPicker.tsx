import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Check } from "lucide-react";
import { create } from "zustand";
import type { Market } from "@sentry-app/polymarket";
import { useWatchlists } from "../../lib/watchlists";
import { useNotifications } from "../../lib/alerts";
import { Btn, cx } from "../ui/primitives";

interface PickerState {
  market: Market | null;
  wallet: { address: string; alias: string } | null;
  openMarket: (m: Market) => void;
  openWallet: (address: string, alias: string) => void;
  close: () => void;
}

export const useWatchPicker = create<PickerState>((set) => ({
  market: null,
  wallet: null,
  openMarket: (market) => set({ market, wallet: null }),
  openWallet: (address, alias) => set({ wallet: { address, alias }, market: null }),
  close: () => set({ market: null, wallet: null }),
}));

export function WatchlistPicker() {
  const { market, wallet, close } = useWatchPicker();
  const { lists, create: createList, addMarket, removeMarket, addWallet, removeWallet } = useWatchlists();
  const notify = useNotifications((s) => s.push);
  const [newName, setNewName] = useState("");

  if (!market && !wallet) return null;

  const toggle = (listId: string) => {
    const list = lists.find((l) => l.id === listId);
    if (!list) return;
    if (market) {
      const has = list.markets.some((m) => m.slug === market.slug);
      if (has) removeMarket(listId, market.slug);
      else {
        addMarket(listId, { slug: market.slug, title: market.question, conditionId: market.conditionId });
        notify({ kind: "SYSTEM", title: "ADDED TO INTELLIGENCE WATCHLIST", body: `${market.question} → ${list.name}`, href: "/watchlists" });
      }
    } else if (wallet) {
      const has = list.wallets.some((w) => w.address === wallet.address.toLowerCase());
      if (has) removeWallet(listId, wallet.address);
      else {
        addWallet(listId, wallet);
        notify({ kind: "SYSTEM", title: "ADDED TO INTELLIGENCE WATCHLIST", body: `${wallet.alias || wallet.address} → ${list.name}`, href: "/watchlists" });
      }
    }
  };

  const createAndAdd = () => {
    const name = newName.trim();
    if (!name) return;
    const id = createList(name);
    setNewName("");
    // add after creation
    setTimeout(() => toggle(id), 0);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={close}>
      <div className="panel w-[360px] border-line-strong" onClick={(e) => e.stopPropagation()}>
        <header className="hairline-b flex h-9 items-center justify-between px-3">
          <span className="label">ASSIGN TO WATCHLIST</span>
          <button onClick={close} className="focus-outline text-faint hover:text-text">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>
        <div className="p-3">
          <div className="mb-2 line-clamp-2 text-[11px] text-dim">
            {market ? market.question : `${wallet!.alias || wallet!.address}`}
          </div>
          <div className="flex max-h-[240px] flex-col gap-px overflow-y-auto bg-line">
            {lists.length === 0 && (
              <div className="bg-raise px-3 py-4 text-center text-[10px] uppercase tracking-[0.1em] text-faint">
                NO WATCHLISTS DEFINED
              </div>
            )}
            {lists.map((l) => {
              const active = market
                ? l.markets.some((m) => m.slug === market.slug)
                : l.wallets.some((w) => w.address === wallet!.address.toLowerCase());
              return (
                <button
                  key={l.id}
                  onClick={() => toggle(l.id)}
                  className={cx(
                    "focus-outline flex h-8 items-center justify-between bg-raise px-3 text-left text-[11px] transition-colors hover:bg-raise3",
                    active ? "text-text" : "text-dim",
                  )}
                >
                  <span>{l.name}</span>
                  {active && <Check size={12} className="text-accent2" strokeWidth={1.5} />}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
              placeholder="NEW WATCHLIST"
              className="focus-outline h-7 flex-1 border border-line bg-raise2 px-2 text-[11px] uppercase tracking-[0.08em] text-text placeholder:text-faint"
            />
            <Btn size="md" variant="accent" onClick={createAndAdd} disabled={!newName.trim()}>
              <Plus size={11} strokeWidth={1.5} /> CREATE
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
