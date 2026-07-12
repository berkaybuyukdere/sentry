/** Raw + normalized types for Polymarket public APIs (Gamma, CLOB, Data-API). */

// ---------------------------------------------------------------------------
// Gamma — market & event metadata
// ---------------------------------------------------------------------------

export interface GammaMarketRaw {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description?: string;
  endDate?: string;
  startDate?: string;
  image?: string;
  icon?: string;
  outcomes?: string; // JSON-encoded string[]
  outcomePrices?: string; // JSON-encoded string[]
  clobTokenIds?: string; // JSON-encoded string[]
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  liquidity?: string;
  liquidityNum?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  spread?: number;
  oneHourPriceChange?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  restricted?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  groupItemTitle?: string;
  events?: GammaEventRaw[];
}

export interface GammaTag {
  id: string;
  label: string;
  slug: string;
}

export interface GammaEventRaw {
  id: string;
  ticker?: string;
  slug: string;
  title: string;
  description?: string;
  icon?: string;
  image?: string;
  endDate?: string;
  creationDate?: string;
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  openInterest?: number;
  negRisk?: boolean;
  tags?: GammaTag[];
  markets?: GammaMarketRaw[];
}

/** Normalized market — every screen consumes this shape, never the raw one. */
export interface Market {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description: string;
  endDate: string | null;
  image: string | null;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  /** probability of outcome[0] (YES for binaries), 0..1 */
  probability: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  spread: number | null;
  volume: number;
  volume24h: number;
  volume1w: number;
  liquidity: number;
  delta1h: number;
  delta24h: number;
  delta7d: number;
  delta1m: number;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  negRisk: boolean;
  tickSize: number;
  minOrderSize: number;
  groupItemTitle: string | null;
  eventTitle: string | null;
  eventSlug: string | null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// CLOB — order book, price history
// ---------------------------------------------------------------------------

export interface PricePoint {
  t: number; // unix seconds
  p: number; // price 0..1
}

export interface PriceHistoryResponse {
  history: PricePoint[];
}

export interface BookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

export type HistoryInterval = "1h" | "6h" | "1d" | "1w" | "1m" | "max";

// ---------------------------------------------------------------------------
// Data-API — trades, positions, holders, leaderboard, activity
// ---------------------------------------------------------------------------

export interface DataTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon?: string;
  eventSlug?: string;
  outcome: string;
  outcomeIndex: number;
  name?: string;
  pseudonym?: string;
  transactionHash: string;
}

export interface DataPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  icon?: string;
  eventId?: string;
  eventSlug?: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface DataActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: "TRADE" | "SPLIT" | "MERGE" | "REDEEM" | "REWARD" | "CONVERSION";
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: "BUY" | "SELL" | "";
  outcomeIndex: number;
  title: string;
  slug: string;
  icon?: string;
  eventSlug?: string;
  outcome: string;
  name?: string;
  pseudonym?: string;
}

export interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  xUsername?: string;
  verifiedBadge?: boolean;
  vol: number;
  pnl: number;
  profileImage?: string;
}

export interface HolderEntry {
  proxyWallet: string;
  asset: string;
  amount: number;
  outcomeIndex: number;
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
}

export interface HoldersResponse {
  token: string;
  holders: HolderEntry[];
}

export interface WalletValue {
  user: string;
  value: number;
}

export type LeaderboardWindow = "1d" | "7d" | "30d" | "all";

// ---------------------------------------------------------------------------
// WebSocket — CLOB market channel
// ---------------------------------------------------------------------------

export interface WsPriceChange {
  event_type: "price_change";
  asset_id: string;
  market: string;
  changes?: { price: string; side: "BUY" | "SELL"; size: string }[];
  price?: string;
  side?: "BUY" | "SELL";
  size?: string;
  timestamp: string;
}

export interface WsBook {
  event_type: "book";
  asset_id: string;
  market: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: string;
  hash: string;
}

export interface WsLastTradePrice {
  event_type: "last_trade_price";
  asset_id: string;
  market: string;
  price: string;
  side: "BUY" | "SELL";
  size: string;
  timestamp: string;
}

export interface WsTickSizeChange {
  event_type: "tick_size_change";
  asset_id: string;
  market: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
}

export type WsMarketMessage = WsPriceChange | WsBook | WsLastTradePrice | WsTickSizeChange;
