import { createSecureClient, production, relayerApiKey, type SecureClient } from "@polymarket/client";
import { useApiAccess } from "../apiAccess";
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
  const rkNow = useApiAccess.getState().relayerV2;
  // cache key includes the relayer key so storing/changing it in Settings
  // invalidates the cached client immediately — no page reload needed
  const key = `${address.toLowerCase()}:${rkNow?.key ?? "none"}`;
  if (cache?.key === key) return cache.client;
  // CLOB v2 rejects direct EOA makers ("maker address not allowed") — orders
  // must come from the account's deterministic Deposit Wallet. Omitting
  // `wallet` makes createSecureClient derive + set it up (gasless) itself —
  // but THAT deployment step itself needs a Relayer or Builder API key
  // ("Deposit Wallet deployment requires a Relayer API Key or Builder API
  // Key in the client configuration"), stored via Settings → RELAYER API KEY.
  const rk = rkNow;
  const client = createSecureClient({
    signer: signerFrom(wallet),
    environment: production,
    ...(rk ? { apiKey: relayerApiKey({ key: rk.key, address: rk.address }) } : {}),
  }).then((c) => {
    localStorage.setItem(DW_KEY(address.toLowerCase()), c.account.wallet);
    return c;
  });
  cache = { key, client };
  client.catch(() => {
    cache = null; // never cache a failed handshake
  });
  return client;
}
