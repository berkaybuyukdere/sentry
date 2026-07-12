import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface WatchlistMarketRef {
  slug: string;
  title: string;
  conditionId: string;
}

export interface WatchlistWalletRef {
  address: string;
  alias: string;
}

export interface Watchlist {
  id: string;
  name: string;
  markets: WatchlistMarketRef[];
  wallets: WatchlistWalletRef[];
  narratives: string[]; // tag slugs
  createdAt: number;
}

interface WatchlistState {
  lists: Watchlist[];
  create: (name: string) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  addMarket: (id: string, m: WatchlistMarketRef) => void;
  removeMarket: (id: string, slug: string) => void;
  addWallet: (id: string, w: WatchlistWalletRef) => void;
  removeWallet: (id: string, address: string) => void;
  toggleNarrative: (id: string, tagSlug: string) => void;
  isWatched: (slug: string) => boolean;
}

export const useWatchlists = create<WatchlistState>()(
  persist(
    (set, get) => ({
      lists: [],
      create: (name) => {
        const id = `WL-${Date.now().toString(36).toUpperCase()}`;
        set((s) => ({
          lists: [...s.lists, { id, name, markets: [], wallets: [], narratives: [], createdAt: Date.now() }],
        }));
        return id;
      },
      rename: (id, name) =>
        set((s) => ({ lists: s.lists.map((l) => (l.id === id ? { ...l, name } : l)) })),
      remove: (id) => set((s) => ({ lists: s.lists.filter((l) => l.id !== id) })),
      addMarket: (id, m) =>
        set((s) => ({
          lists: s.lists.map((l) =>
            l.id === id && !l.markets.some((x) => x.slug === m.slug)
              ? { ...l, markets: [...l.markets, m] }
              : l,
          ),
        })),
      removeMarket: (id, slug) =>
        set((s) => ({
          lists: s.lists.map((l) =>
            l.id === id ? { ...l, markets: l.markets.filter((m) => m.slug !== slug) } : l,
          ),
        })),
      addWallet: (id, w) =>
        set((s) => ({
          lists: s.lists.map((l) =>
            l.id === id && !l.wallets.some((x) => x.address.toLowerCase() === w.address.toLowerCase())
              ? { ...l, wallets: [...l.wallets, { ...w, address: w.address.toLowerCase() }] }
              : l,
          ),
        })),
      removeWallet: (id, address) =>
        set((s) => ({
          lists: s.lists.map((l) =>
            l.id === id
              ? { ...l, wallets: l.wallets.filter((w) => w.address !== address.toLowerCase()) }
              : l,
          ),
        })),
      toggleNarrative: (id, tagSlug) =>
        set((s) => ({
          lists: s.lists.map((l) =>
            l.id === id
              ? {
                  ...l,
                  narratives: l.narratives.includes(tagSlug)
                    ? l.narratives.filter((n) => n !== tagSlug)
                    : [...l.narratives, tagSlug],
                }
              : l,
          ),
        })),
      isWatched: (slug) => get().lists.some((l) => l.markets.some((m) => m.slug === slug)),
    }),
    { name: "sentry.watchlists" },
  ),
);
