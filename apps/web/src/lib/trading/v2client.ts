import { createSecureClient, production, forkEnvironmentConfig, relayerApiKey, type SecureClient } from "@polymarket/client";
import { useApiAccess } from "../apiAccess";
import { POLY_PROXY_WALLET, LEGACY_DEPOSIT_WALLET, USDC } from "./constants";
import { builderApiKeyBrowser } from "./builderAuth";
import { useSessionSigner, sessionAddress } from "./sessionSigner";
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

// keyed by signer identity + auth: the desk can alternate between the main
// Phantom account and the autopilot session signer within one exit tick — a
// single-slot cache would re-handshake (and re-prompt Phantom) on every swap
const cache = new Map<string, Promise<SecureClient>>();

const DW_KEY = (addr: string) => `sentry.depositWallet.${addr.toLowerCase()}`;

/** The trading wallet SENTRY funds and trades from. For the operator's main
 *  EOA this is the REAL Polymarket proxy wallet (POLY_PROXY_WALLET, confirmed
 *  on-chain: pUSD balance matches the site's Cash exactly, plus an
 *  already-maxed v2-exchange allowance — see constants.ts for the chase). For
 *  the AUTOPILOT session signer it is that account's own proxy, pasted from
 *  its polymarket.com profile — never guessed (v21 lesson). */
export function cachedDepositWallet(address: string): `0x${string}` | null {
  const sess = useSessionSigner.getState();
  const sessAddr = sessionAddress();
  if (sessAddr && address.toLowerCase() === sessAddr.toLowerCase()) return sess.proxyWallet;
  return POLY_PROXY_WALLET;
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
  // A relayer key only authenticates its own bound address — attaching it to
  // a DIFFERENT signer (the autopilot session key) manufactures the exact
  // "does not match auth" fault we spent v11–v13 killing, so it is only
  // passed when the bound address matches the signing address.
  const relayerMatches = relayerV2 && relayerV2.address.toLowerCase() === address.toLowerCase();
  const auth = relayerMatches
    ? relayerApiKey({ key: relayerV2.key, address: relayerV2.address })
    : builder
      ? builderApiKeyBrowser({ key: builder.apiKey, secret: builder.secret, passphrase: builder.passphrase })
      : undefined;
  // the maker wallet is signer-dependent: main EOA → confirmed proxy wallet;
  // session signer → its own pasted proxy (cachedDepositWallet resolves both).
  // A session account with NO proxy linked must never fall through to the
  // client's self-derived wallet — that is the exact wrong-maker path that
  // stranded funds in LEGACY_DEPOSIT_WALLET (v19/v20). Fail loudly instead.
  const makerWallet = cachedDepositWallet(address);
  if (!makerWallet) {
    throw new Error(
      "Session account has no linked proxy wallet — deposit on polymarket.com with this account, then paste its profile address into AUTOPILOT SIGNER before trading.",
    );
  }
  // cache key includes the auth identity so changing keys in Settings
  // invalidates the cached client immediately — no page reload needed
  const key = `${address.toLowerCase()}:${makerWallet}:${(relayerMatches && relayerV2?.key) || builder?.apiKey || "none"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // CLOB v2 rejects direct EOA makers ("maker address not allowed") — orders
  // must come from the account's deterministic Deposit Wallet. Omitting
  // `wallet` makes createSecureClient derive + set it up (gasless) itself —
  // but THAT deployment step itself needs a Relayer or Builder API key
  // ("Deposit Wallet deployment requires a Relayer API Key or Builder API
  // Key in the client configuration"), stored via Settings → RELAYER API KEY.
  const client = createSecureClient({
    signer: signerFrom(wallet),
    environment,
    wallet: makerWallet,
    ...(auth ? { apiKey: auth } : {}),
  }).then((c) => {
    localStorage.setItem(DW_KEY(address.toLowerCase()), c.account.wallet);
    return c;
  });
  cache.set(key, client);
  client.catch(() => {
    cache.delete(key); // never cache a failed handshake
  });
  return client;
}

/**
 * Pulls stranded funds out of the beta client's self-derived deposit wallet
 * (LEGACY_DEPOSIT_WALLET) back to the operator's own EOA. One-off client
 * bound to the legacy wallet; the transfer runs through the gasless relayer
 * and is signed by the user's wallet — nothing custodial.
 */
export async function recoverLegacyFunds(
  wallet: WalletClient,
  address: `0x${string}`,
  amountUnits: bigint,
): Promise<string> {
  const { relayerV2, builder } = useApiAccess.getState();
  const auth = relayerV2
    ? relayerApiKey({ key: relayerV2.key, address: relayerV2.address })
    : builder
      ? builderApiKeyBrowser({ key: builder.apiKey, secret: builder.secret, passphrase: builder.passphrase })
      : undefined;
  const client = await createSecureClient({
    signer: signerFrom(wallet),
    environment,
    wallet: LEGACY_DEPOSIT_WALLET,
    ...(auth ? { apiKey: auth } : {}),
  });
  const handle = await client.transferErc20({
    amount: amountUnits,
    recipientAddress: address,
    tokenAddress: USDC,
  });
  const outcome = await handle.wait();
  return outcome.transactionHash;
}
