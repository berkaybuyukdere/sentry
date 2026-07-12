import { createSecureClient, production, type SecureClient } from "@polymarket/client";
import { signerFrom } from "@polymarket/client/viem";
import type { WalletClient } from "viem";

/**
 * Official Polymarket V2 client, authenticated for the connected wallet.
 *
 * Polymarket's April-2026 CLOB v2 migration changed the order EIP-712 type
 * hash server-side; hand-rolled signing paths are rejected with
 * "invalid order version" even when they byte-match the published ts-sdk
 * struct. The official client is the only supported signing path, so all
 * order placement routes through it. Reads (gamma/data-api/books) are
 * unaffected and stay on our own client.
 *
 * Non-custodial invariant holds: `signerFrom(walletClient)` delegates every
 * signature to the user's own wallet; nothing is signed without a prompt.
 */

let cache: { key: string; client: Promise<SecureClient> } | null = null;

const DW_KEY = (addr: string) => `sentry.depositWallet.${addr.toLowerCase()}`;

/** Deposit (trading) wallet derived for this EOA on a previous client
 *  handshake — lets passive UI show the trading wallet without a signature. */
export function cachedDepositWallet(address: string): `0x${string}` | null {
  const v = localStorage.getItem(DW_KEY(address));
  return v && v.startsWith("0x") ? (v as `0x${string}`) : null;
}

export function getV2Client(wallet: WalletClient, address: `0x${string}`): Promise<SecureClient> {
  const key = address.toLowerCase();
  if (cache?.key === key) return cache.client;
  // CLOB v2 rejects direct EOA makers ("maker address not allowed") — orders
  // must come from the account's deterministic Deposit Wallet. Omitting
  // `wallet` makes createSecureClient derive + set it up (gasless) itself.
  const client = createSecureClient({
    signer: signerFrom(wallet),
    environment: production,
  }).then((c) => {
    localStorage.setItem(DW_KEY(key), c.account.wallet);
    return c;
  });
  cache = { key, client };
  client.catch(() => {
    cache = null; // never cache a failed handshake
  });
  return client;
}
