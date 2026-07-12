import type {
  DataActivity,
  DataPosition,
  DataTrade,
  HoldersResponse,
  LeaderboardEntry,
  LeaderboardWindow,
  WalletValue,
} from "./types";

export const DATA_BASE = "https://data-api.polymarket.com";

async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const res = await fetch(`${DATA_BASE}${path}?${p}`);
  if (!res.ok) throw new Error(`data-api ${path} ${res.status}`);
  return (await res.json()) as T;
}

/** Global or filtered trade tape. Powers the live activity stream + whale detection. */
export function fetchTrades(opts: {
  user?: string;
  market?: string; // conditionId
  limit?: number;
  offset?: number;
  takerOnly?: boolean;
  side?: "BUY" | "SELL";
}): Promise<DataTrade[]> {
  return get<DataTrade[]>("/trades", {
    user: opts.user,
    market: opts.market,
    limit: opts.limit ?? 100,
    offset: opts.offset,
    takerOnly: opts.takerOnly === undefined ? undefined : String(opts.takerOnly),
    side: opts.side,
  });
}

export function fetchPositions(opts: {
  user: string;
  limit?: number;
  offset?: number;
  sortBy?: "CURRENT" | "INITIAL" | "CASHPNL" | "PERCENTPNL" | "TOKENS" | "PRICE";
  sortDirection?: "ASC" | "DESC";
  sizeThreshold?: number;
}): Promise<DataPosition[]> {
  return get<DataPosition[]>("/positions", {
    user: opts.user,
    limit: opts.limit ?? 100,
    offset: opts.offset,
    sortBy: opts.sortBy ?? "CURRENT",
    sortDirection: opts.sortDirection,
    sizeThreshold: opts.sizeThreshold ?? 1,
  });
}

export function fetchActivity(opts: {
  user: string;
  limit?: number;
  offset?: number;
  type?: string;
}): Promise<DataActivity[]> {
  return get<DataActivity[]>("/activity", {
    user: opts.user,
    limit: opts.limit ?? 100,
    offset: opts.offset,
    type: opts.type,
  });
}

export function fetchLeaderboard(
  window: LeaderboardWindow,
  limit = 50,
): Promise<LeaderboardEntry[]> {
  return get<LeaderboardEntry[]>("/v1/leaderboard", { window, limit });
}

export function fetchHolders(conditionId: string, limit = 12): Promise<HoldersResponse[]> {
  return get<HoldersResponse[]>("/holders", { market: conditionId, limit });
}

export async function fetchWalletValue(user: string): Promise<number> {
  const rows = await get<WalletValue[]>("/value", { user });
  return rows[0]?.value ?? 0;
}
