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

export function getV2Client(wallet: WalletClient, address: `0x${string}`): Promise<SecureClient> {
  const key = address.toLowerCase();
  if (cache?.key === key) return cache.client;
  const client = createSecureClient({
    signer: signerFrom(wallet),
    // pass the EOA itself as the account wallet — otherwise the client
    // derives a Deposit Wallet and trades from an address the user hasn't funded
    wallet: address,
    environment: production,
  });
  cache = { key, client };
  client.catch(() => {
    cache = null; // never cache a failed handshake
  });
  return client;
}
