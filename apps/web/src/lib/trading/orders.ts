import type { WalletClient } from "viem";
import { OrderSide as V2Side, OrderType as V2OrderType } from "@polymarket/client";
import { ensureCreds, clobAuthed, type ClobCreds } from "./clobAuth";
import { getV2Client } from "./v2client";
import { useApiAccess } from "../apiAccess";

/**
 * EIP-712 order construction + submission to the Polymarket CLOB.
 * Non-custodial: the order is signed by the user's own wallet; SENTRY only
 * transports the signed payload. signatureType 0 = direct EOA maker.
 */

export type OrderSide = "BUY" | "SELL";
export type ClobOrderType = "GTC" | "FAK" | "FOK";

export interface OrderIntent {
  tokenId: string;
  side: OrderSide;
  /** limit price 0..1, will be snapped to tick */
  price: number;
  /** number of outcome shares (max 2 decimals) */
  shares: number;
  tickSize: number;
  negRisk: boolean;
  orderType: ClobOrderType;
}

export interface PlacedOrder {
  success: boolean;
  errorMsg?: string;
  orderID?: string;
  status?: string; // matched | live | delayed | unmatched
  transactionsHashes?: string[];
  takingAmount?: string;
  makingAmount?: string;
}

export function snapToTick(price: number, tick: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const snapped = Math.round(price / tick) * tick;
  const bounded = Math.min(1 - tick, Math.max(tick, snapped));
  return Number(bounded.toFixed(decimals));
}

/**
 * Places an order through the official Polymarket V2 client (CLOB v2 — the
 * only signing path the server accepts since the April-2026 migration).
 * MARKET intents map to placeMarketOrder with a price bound; GTC intents map
 * to placeLimitOrder. The user's wallet signs; a missing V2 trading approval
 * is repaired once via setupTradingApprovals and the order retried.
 */
export async function signAndPlaceOrder(
  wallet: WalletClient,
  address: `0x${string}`,
  intent: OrderIntent,
): Promise<PlacedOrder> {
  const client = await getV2Client(wallet, address);
  const price = snapToTick(intent.price, intent.tickSize);
  const shares = Math.floor(intent.shares * 100) / 100;
  const builderCode = useApiAccess.getState().builder?.builderCode;
  const builder = builderCode?.startsWith("0x") ? { builderCode: builderCode as `0x${string}` } : {};

  const place = async () => {
    if (intent.orderType === "GTC") {
      return client.placeLimitOrder({
        tokenId: intent.tokenId,
        price,
        size: shares,
        side: intent.side === "BUY" ? V2Side.BUY : V2Side.SELL,
        ...builder,
      });
    }
    const orderType = intent.orderType === "FOK" ? V2OrderType.FOK : V2OrderType.FAK;
    if (intent.side === "BUY") {
      const amount = Math.round(price * shares * 100) / 100;
      return client.placeMarketOrder({
        tokenId: intent.tokenId,
        side: V2Side.BUY,
        amount,
        maxSpend: amount, // hard cap: fees come out of the stated notional
        maxPrice: price, // slippage-guarded bound computed by the caller
        orderType,
        ...builder,
      });
    }
    return client.placeMarketOrder({
      tokenId: intent.tokenId,
      side: V2Side.SELL,
      shares,
      minPrice: price,
      orderType,
      ...builder,
    });
  };

  let res: Awaited<ReturnType<typeof place>>;
  try {
    res = await place();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/allowance|approv|balance/i.test(msg)) {
      // V2 trading approvals differ from the legacy USDC.e grants — let the
      // official client repair them (wallet prompts), then retry once
      await client.setupTradingApprovals(); // waits for confirmation internally
      res = await place();
    } else {
      throw e;
    }
  }

  const r = res as unknown as {
    ok?: boolean;
    orderId?: string;
    status?: string;
    errorMsg?: string;
    makingAmount?: string;
    takingAmount?: string;
    transactionsHashes?: string[];
  };
  return {
    success: r.ok !== false,
    errorMsg: r.errorMsg,
    orderID: r.orderId,
    status: r.status,
    transactionsHashes: r.transactionsHashes,
    makingAmount: r.makingAmount,
    takingAmount: r.takingAmount,
  };
}

export interface OpenOrder {
  id: string;
  status: string;
  market: string;
  asset_id: string;
  side: OrderSide;
  price: string;
  original_size: string;
  size_matched: string;
  created_at: number;
  order_type: string;
}

export async function fetchOpenOrdersWithCreds(
  address: string,
  creds: ClobCreds,
): Promise<OpenOrder[]> {
  const res = await clobAuthed<OpenOrder[] | { data?: OpenOrder[] }>(
    address,
    creds,
    "GET",
    "/data/orders",
  );
  return Array.isArray(res) ? res : (res.data ?? []);
}

export async function fetchOpenOrders(
  wallet: WalletClient,
  address: `0x${string}`,
): Promise<OpenOrder[]> {
  const creds = await ensureCreds(wallet, address);
  return fetchOpenOrdersWithCreds(address, creds);
}

export async function cancelOrderWithCreds(
  address: string,
  creds: ClobCreds,
  orderID: string,
): Promise<{ canceled?: string[]; not_canceled?: Record<string, string> }> {
  return clobAuthed(address, creds, "DELETE", "/order", { orderID });
}

export async function cancelOrder(
  wallet: WalletClient,
  address: `0x${string}`,
  orderID: string,
): Promise<{ canceled?: string[]; not_canceled?: Record<string, string> }> {
  const creds = await ensureCreds(wallet, address);
  return cancelOrderWithCreds(address, creds, orderID);
}
