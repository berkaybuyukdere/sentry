import { useQuery, useQueries } from "@tanstack/react-query";
import {
  fetchMarkets,
  fetchMarketBySlug,
  fetchEvents,
  fetchPriceHistory,
  fetchOrderBook,
  fetchTrades,
  fetchPositions,
  fetchActivity,
  fetchLeaderboard,
  fetchHolders,
  fetchWalletValue,
  searchGamma,
  type MarketQuery,
  type EventQuery,
  type HistoryInterval,
  type LeaderboardWindow,
} from "@sentry-app/polymarket";

/** Primary market universe — top markets by 24h volume, refreshed continuously. */
export function useMarkets(q: MarketQuery = {}, refetchMs = 30_000) {
  return useQuery({
    queryKey: ["markets", q],
    queryFn: () => fetchMarkets({ active: true, closed: false, ...q }),
    refetchInterval: refetchMs,
    staleTime: 15_000,
  });
}

export function useMarket(slug: string | undefined) {
  return useQuery({
    queryKey: ["market", slug],
    queryFn: () => fetchMarketBySlug(slug!),
    enabled: !!slug,
    refetchInterval: 20_000,
  });
}

export function useEvents(q: EventQuery = {}, refetchMs = 60_000) {
  return useQuery({
    queryKey: ["events", q],
    queryFn: () => fetchEvents({ active: true, closed: false, ...q }),
    refetchInterval: refetchMs,
    staleTime: 30_000,
  });
}

export function useEventBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: ["event", slug],
    queryFn: async () => (await fetchEvents({ slug: slug!, limit: 1 }))[0] ?? null,
    enabled: !!slug,
  });
}

export function usePriceHistory(tokenId: string | undefined, interval: HistoryInterval, fidelity?: number) {
  return useQuery({
    queryKey: ["history", tokenId, interval, fidelity],
    queryFn: () => fetchPriceHistory(tokenId!, interval, fidelity),
    enabled: !!tokenId,
    refetchInterval: interval === "1h" || interval === "6h" ? 30_000 : 120_000,
  });
}

export function useOrderBook(tokenId: string | undefined, refetchMs = 8_000) {
  return useQuery({
    queryKey: ["book", tokenId],
    queryFn: () => fetchOrderBook(tokenId!),
    enabled: !!tokenId,
    refetchInterval: refetchMs,
  });
}

export function useMarketTrades(conditionId: string | undefined, limit = 40) {
  return useQuery({
    queryKey: ["trades", "market", conditionId, limit],
    queryFn: () => fetchTrades({ market: conditionId!, limit, takerOnly: true }),
    enabled: !!conditionId,
    refetchInterval: 10_000,
  });
}

export function useWalletTrades(user: string | undefined, limit = 200) {
  return useQuery({
    queryKey: ["trades", "user", user, limit],
    queryFn: () => fetchTrades({ user: user!, limit, takerOnly: false }),
    enabled: !!user,
    refetchInterval: 30_000,
  });
}

export function usePositions(user: string | undefined) {
  return useQuery({
    queryKey: ["positions", user],
    queryFn: () => fetchPositions({ user: user!, limit: 200 }),
    enabled: !!user,
    refetchInterval: 30_000,
  });
}

export function useWalletActivity(user: string | undefined, limit = 300) {
  return useQuery({
    queryKey: ["activity", user, limit],
    queryFn: () => fetchActivity({ user: user!, limit }),
    enabled: !!user,
    refetchInterval: 45_000,
  });
}

export function useLeaderboard(window: LeaderboardWindow, limit = 50) {
  return useQuery({
    queryKey: ["leaderboard", window, limit],
    queryFn: () => fetchLeaderboard(window, limit),
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
  });
}

export function useHolders(conditionId: string | undefined) {
  return useQuery({
    queryKey: ["holders", conditionId],
    queryFn: () => fetchHolders(conditionId!),
    enabled: !!conditionId,
    refetchInterval: 60_000,
  });
}

export function useWalletValue(user: string | undefined) {
  return useQuery({
    queryKey: ["value", user],
    queryFn: () => fetchWalletValue(user!),
    enabled: !!user,
    refetchInterval: 30_000,
  });
}

export function useIntelSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: () => searchGamma(q),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}

/** Wide desk universe for the AI sweep — volume- and liquidity-ordered gamma
 *  pages merged and deduped (~2,000+ distinct active markets), so even a quiet
 *  market offers a broad candidate pool. */
export function useDeskUniverse(refetchMs = 25_000) {
  return useQuery({
    queryKey: ["desk-universe"],
    queryFn: async () => {
      const pages = await Promise.all([
        fetchMarkets({ active: true, closed: false, limit: 500, offset: 0, order: "volume24hr" }),
        fetchMarkets({ active: true, closed: false, limit: 500, offset: 500, order: "volume24hr" }),
        fetchMarkets({ active: true, closed: false, limit: 500, offset: 1000, order: "volume24hr" }),
        fetchMarkets({ active: true, closed: false, limit: 500, offset: 0, order: "liquidity" }),
        fetchMarkets({ active: true, closed: false, limit: 500, offset: 500, order: "liquidity" }),
      ]);
      const seen = new Set<string>();
      const merged = [];
      for (const m of pages.flat()) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          merged.push(m);
        }
      }
      return merged;
    },
    refetchInterval: refetchMs,
    staleTime: 15_000,
  });
}

/** Positions for several wallets at once (copy-engine + watchlist wallets). */
export function useMultiWalletPositions(wallets: string[]) {
  return useQueries({
    queries: wallets.map((w) => ({
      queryKey: ["positions", w.toLowerCase()],
      queryFn: () => fetchPositions({ user: w, limit: 100 }),
      refetchInterval: 60_000,
    })),
  });
}
