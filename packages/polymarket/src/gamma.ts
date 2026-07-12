import type { GammaEventRaw, GammaMarketRaw, Market } from "./types";

export const GAMMA_BASE = "https://gamma-api.polymarket.com";

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizeMarket(raw: GammaMarketRaw, parentEvent?: GammaEventRaw): Market {
  const outcomes = parseJsonArray(raw.outcomes);
  const outcomePrices = parseJsonArray(raw.outcomePrices).map(Number);
  const event = parentEvent ?? raw.events?.[0];
  return {
    id: raw.id,
    question: raw.question,
    conditionId: raw.conditionId,
    slug: raw.slug,
    description: raw.description ?? "",
    endDate: raw.endDate ?? null,
    image: raw.icon ?? raw.image ?? null,
    outcomes,
    outcomePrices,
    clobTokenIds: parseJsonArray(raw.clobTokenIds),
    probability: outcomePrices[0] ?? 0,
    bestBid: raw.bestBid ?? null,
    bestAsk: raw.bestAsk ?? null,
    lastTradePrice: raw.lastTradePrice ?? null,
    spread: raw.spread ?? null,
    volume: raw.volumeNum ?? Number(raw.volume ?? 0),
    volume24h: raw.volume24hr ?? 0,
    volume1w: raw.volume1wk ?? 0,
    liquidity: raw.liquidityNum ?? Number(raw.liquidity ?? 0),
    delta1h: raw.oneHourPriceChange ?? 0,
    delta24h: raw.oneDayPriceChange ?? 0,
    delta7d: raw.oneWeekPriceChange ?? 0,
    delta1m: raw.oneMonthPriceChange ?? 0,
    active: raw.active ?? false,
    closed: raw.closed ?? false,
    acceptingOrders: raw.acceptingOrders ?? false,
    negRisk: raw.negRisk ?? false,
    tickSize: raw.orderPriceMinTickSize ?? 0.01,
    minOrderSize: raw.orderMinSize ?? 5,
    groupItemTitle: raw.groupItemTitle || null,
    eventTitle: event?.title ?? null,
    eventSlug: event?.slug ?? null,
    tags: (event?.tags ?? []).map((t) => t.label),
  };
}

export interface MarketQuery {
  limit?: number;
  offset?: number;
  order?: "volume24hr" | "liquidity" | "startDate" | "endDate" | "volumeNum";
  ascending?: boolean;
  active?: boolean;
  closed?: boolean;
  liquidityNumMin?: number;
  volumeNumMin?: number;
  tagId?: string;
  slug?: string;
  conditionIds?: string[];
}

/** Gamma serves at most 100 rows per request regardless of `limit`. */
const GAMMA_PAGE = 100;

async function fetchMarketsPage(q: MarketQuery, limit: number, offset: number): Promise<Market[]> {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  if (offset) p.set("offset", String(offset));
  p.set("order", q.order ?? "volume24hr");
  p.set("ascending", String(q.ascending ?? false));
  if (q.active !== undefined) p.set("active", String(q.active));
  if (q.closed !== undefined) p.set("closed", String(q.closed));
  if (q.liquidityNumMin) p.set("liquidity_num_min", String(q.liquidityNumMin));
  if (q.volumeNumMin) p.set("volume_num_min", String(q.volumeNumMin));
  if (q.tagId) p.set("tag_id", q.tagId);
  if (q.slug) p.set("slug", q.slug);
  for (const c of q.conditionIds ?? []) p.append("condition_ids", c);
  const res = await fetch(`${GAMMA_BASE}/markets?${p}`);
  if (!res.ok) throw new Error(`gamma /markets ${res.status}`);
  const raw = (await res.json()) as GammaMarketRaw[];
  return raw.map((m) => normalizeMarket(m));
}

/** Transparently paginates when limit > 100 (parallel pages, deduped). */
export async function fetchMarkets(q: MarketQuery = {}): Promise<Market[]> {
  const want = q.limit ?? 100;
  const base = q.offset ?? 0;
  if (want <= GAMMA_PAGE) return fetchMarketsPage(q, want, base);
  const pages = Math.ceil(want / GAMMA_PAGE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      fetchMarketsPage(q, GAMMA_PAGE, base + i * GAMMA_PAGE).catch(() => [] as Market[]),
    ),
  );
  const seen = new Set<string>();
  return results.flat().filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

export async function fetchMarketBySlug(slug: string): Promise<Market | null> {
  const markets = await fetchMarkets({ slug, limit: 1 });
  return markets[0] ?? null;
}

export interface EventQuery {
  limit?: number;
  offset?: number;
  order?: "volume24hr" | "liquidity" | "openInterest" | "startDate";
  ascending?: boolean;
  active?: boolean;
  closed?: boolean;
  slug?: string;
  tagSlug?: string;
}

export async function fetchEvents(q: EventQuery = {}): Promise<GammaEventRaw[]> {
  const p = new URLSearchParams();
  p.set("limit", String(q.limit ?? 50));
  if (q.offset) p.set("offset", String(q.offset));
  p.set("order", q.order ?? "volume24hr");
  p.set("ascending", String(q.ascending ?? false));
  if (q.active !== undefined) p.set("active", String(q.active));
  if (q.closed !== undefined) p.set("closed", String(q.closed));
  if (q.slug) p.set("slug", q.slug);
  if (q.tagSlug) p.set("tag_slug", q.tagSlug);
  const res = await fetch(`${GAMMA_BASE}/events?${p}`);
  if (!res.ok) throw new Error(`gamma /events ${res.status}`);
  return (await res.json()) as GammaEventRaw[];
}

/** Full-text search over markets/events/profiles. */
export async function searchGamma(query: string): Promise<{
  markets: Market[];
  events: GammaEventRaw[];
}> {
  const p = new URLSearchParams({
    q: query,
    limit_per_type: "8",
    events_status: "active",
  });
  const res = await fetch(`${GAMMA_BASE}/public-search?${p}`);
  if (!res.ok) throw new Error(`gamma /public-search ${res.status}`);
  const data = (await res.json()) as { events?: GammaEventRaw[]; tags?: unknown[] };
  const events = data.events ?? [];
  const markets: Market[] = [];
  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      markets.push(normalizeMarket(m, ev));
    }
  }
  return { markets, events };
}
