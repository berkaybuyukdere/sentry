import { createSecureClient, production, forkEnvironmentConfig, relayerApiKey, type SecureClient } from "@polymarket/client";
import { useApiAccess } from "../apiAccess";
import { builderApiKeyBrowser } from "./builderAuth";
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

// The client's default `production` environment points its on-chain reads
// (allowance checks inside setupTradingApprovals, isWalletDeployed, etc.) at
// https://polygon.drpc.org, which 500s under load — that silently aborted
// every approval-repair attempt with no visible error to the user. Fork onto
// the same reliable RPC our own wagmi config already trusts.
const RELIABLE_RPC = "https://polygon-bor-rpc.publicnode.com";
const environment = forkEnvironmentConfig({ name: "sentry", rpc: RELIABLE_RPC }, production);

let cache: { key: string; client: Promise<SecureClient> } | null = null;

const DW_KEY = (addr: string) => `sentry.depositWallet.${addr.toLowerCase()}`;

/** Deposit (trading) wallet derived for this EOA on a previous client
 *  handshake — lets passive UI show the trading wallet without a signature. */
export function cachedDepositWallet(address: string): `0x${string}` | null {
  const v = localStorage.getItem(DW_KEY(address));
  return v && v.startsWith("0x") ? (v as `0x${string}`) : null;
}

export function getV2Client(wallet: WalletClient, address: `0x${string}`): Promise<SecureClient> {
  const { builder, relayerV2 } = useApiAccess.getState();
  // Auth findings (probed live against relayer-v2 /submit, 2026-07-12):
  //   RELAYER_API_KEY headers  → 400 "invalid 'type' field"  (auth ACCEPTED)
  //   POLY_BUILDER_* HMAC      → 401 "invalid authorization" (rejected on
  //   writes even though GET /nonce returns 200 — builder = read-only here)
  // So the personal relayer key is the only auth the client can carry. It
  // cannot deploy the Deposit Wallet for the user's EOA either ("from 0x…
  // does not match auth 0x…") — deployment must happen through Polymarket's
  // own deposit flow (polymarket.com, same wallet). Once deployed, the
  // client skips deployment entirely and orders never touch the relayer.
  const auth = relayerV2
    ? relayerApiKey({ key: relayerV2.key, address: relayerV2.address })
    : builder
      ? builderApiKeyBrowser({ key: builder.apiKey, secret: builder.secret, passphrase: builder.passphrase })
      : undefined;
  // cache key includes the auth identity so changing keys in Settings
  // invalidates the cached client immediately — no page reload needed
  const key = `${address.toLowerCase()}:${relayerV2?.key ?? builder?.apiKey ?? "none"}`;
  if (cache?.key === key) return cache.client;
  // CLOB v2 rejects direct EOA makers ("maker address not allowed") — orders
  // must come from the account's deterministic Deposit Wallet. Omitting
  // `wallet` makes createSecureClient derive + set it up (gasless) itself —
  // but THAT deployment step itself needs a Relayer or Builder API key
  // ("Deposit Wallet deployment requires a Relayer API Key or Builder API
  // Key in the client configuration"), stored via Settings → RELAYER API KEY.
  const client = createSecureClient({
    signer: signerFrom(wallet),
    environment,
    ...(auth ? { apiKey: auth } : {}),
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
