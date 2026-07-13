import { create } from "zustand";
import { persist } from "zustand/middleware";
import { l2Headers, type ClobCreds } from "./trading/clobAuth";
import { CLOB_HOST } from "./trading/constants";

/**
 * Imported API credentials (stored locally only, never transmitted anywhere
 * except the Polymarket surface they authenticate against).
 *
 * CLOB credentials  → authenticated reads + cancels without a wallet.
 * Builder key       → relayer surface (gasless proxy transactions tier).
 * Order CREATION always requires a wallet signature — protocol rule.
 */

export interface ImportedClob extends ClobCreds {
  address: string;
}

export interface BuilderKey {
  apiKey: string;
  secret: string;
  passphrase: string;
  builderCode: string;
  signerAddress: string;
}

/** V2 "Relayer API Key" from the Polymarket portal's Relayer API Keys tab —
 *  a bare {key, address} pair, distinct from the legacy HMAC BuilderKey.
 *  Fed to `@polymarket/client`'s `relayerApiKey()` so `createSecureClient`
 *  can deploy/use the Deposit Wallet gaslessly ("Deposit Wallet deployment
 *  requires a Relayer API Key or Builder API Key" is the error without it). */
export interface RelayerV2Key {
  key: string;
  address: string;
}

interface ApiAccessState {
  clob: ImportedClob | null;
  builder: BuilderKey | null;
  relayerV2: RelayerV2Key | null;
  setClob: (c: ImportedClob | null) => void;
  setBuilder: (b: BuilderKey | null) => void;
  setRelayerV2: (r: RelayerV2Key | null) => void;
}

/** Operator's own keys, baked in at their explicit request so every machine
 *  boots trade-ready without manual entry. Single-operator terminal +
 *  private repo; Settings can still override/purge (purge falls back here). */
export const DEFAULT_BUILDER: BuilderKey = {
  apiKey: "019f51e7-ed97-77a0-b446-691d6a1cb129",
  secret: "VKDrNuohS7HAHa4kqgb3DVHhyPP9aLFR9eXRF_77zRs=",
  passphrase: "8f6b03c6e0ef7867f60aa390ce71a6d974d7",
  builderCode: "0xfd00246206e6ea81286125bdaa3dbd41a00215daa54dd038addf41a9b19ca041",
  signerAddress: "0xf39532def06c25b87d1f77192c91aca5dca54264",
};

// Bound to the OPERATOR'S OWN trading EOA (0xd99b...1827) — the prior key
// was bound to a different signer address and got "from 0x… does not match
// auth 0x…" on every relayer submit. A relayer key can only act for its own
// bound address, so this one must match whichever wallet is connected.
export const DEFAULT_RELAYER_V2: RelayerV2Key = {
  key: "019f5a02-3fb9-7828-ab5e-baba4eba9a57",
  address: "0xd99b056b407e5acb19598cacb00cdcddd0d11827",
};

// Every relayer key this project has ever shipped as a default. When a
// browser's persisted store still holds one of these (from before a key
// rotation), it's stale operator config, not a user override — auto-upgrade
// it to the current default instead of silently shadowing the fix forever.
const RETIRED_RELAYER_KEYS = ["019f582d-ec01-7db3-b000-a801c73ce83e"];

export const useApiAccess = create<ApiAccessState>()(
  persist(
    (set) => ({
      clob: null,
      builder: DEFAULT_BUILDER,
      relayerV2: DEFAULT_RELAYER_V2,
      setClob: (clob) => set({ clob: clob ? { ...clob, address: clob.address.toLowerCase() } : null }),
      setBuilder: (builder) => set({ builder }),
      setRelayerV2: (relayerV2) => set({ relayerV2 }),
    }),
    {
      name: "sentry.apiAccess",
      // persisted nulls (e.g. an old purge) must not shadow the baked-in
      // defaults — trading requires builder auth to function at all
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ApiAccessState>;
        const relayerStale = p.relayerV2 && RETIRED_RELAYER_KEYS.includes(p.relayerV2.key);
        return {
          ...current,
          ...p,
          builder: p.builder ?? DEFAULT_BUILDER,
          relayerV2: relayerStale ? DEFAULT_RELAYER_V2 : (p.relayerV2 ?? DEFAULT_RELAYER_V2),
        };
      },
    },
  ),
);

/** Live verification of imported CLOB creds against /auth/api-keys. */
export async function testClobCreds(c: ImportedClob): Promise<{ ok: boolean; detail: string }> {
  try {
    const headers = await l2Headers(c.address, c, "GET", "/auth/api-keys");
    const res = await fetch(`${CLOB_HOST}/auth/api-keys`, { headers });
    const text = await res.text();
    if (res.ok) return { ok: true, detail: "CLOB READ ACCESS VERIFIED" };
    return { ok: false, detail: `CLOB ${res.status} — ${text.slice(0, 90)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network fault" };
  }
}

const RELAYER_HOST = "https://relayer-v2.polymarket.com";

async function builderHmac(secret: string, message: string): Promise<string> {
  const norm = secret.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("raw", bytes as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  let out = "";
  for (const b of new Uint8Array(sig)) out += String.fromCharCode(b);
  return btoa(out).replaceAll("+", "-").replaceAll("/", "_");
}

/** Live verification of a builder key against the relayer nonce endpoint. */
export async function testBuilderKey(b: BuilderKey): Promise<{ ok: boolean; detail: string }> {
  try {
    const ts = String(Math.floor(Date.now() / 1000));
    const path = `/nonce?address=${b.signerAddress || "0x0000000000000000000000000000000000000000"}&type=SAFE`;
    const headers = {
      POLY_BUILDER_API_KEY: b.apiKey,
      POLY_BUILDER_TIMESTAMP: ts,
      POLY_BUILDER_PASSPHRASE: b.passphrase,
      POLY_BUILDER_SIGNATURE: await builderHmac(b.secret, `${ts}GET${path}`),
    };
    const res = await fetch(`${RELAYER_HOST}${path}`, { headers });
    const text = await res.text();
    if (res.ok) return { ok: true, detail: "RELAYER LINK VERIFIED" };
    return { ok: false, detail: `RELAYER ${res.status} — ${text.slice(0, 90)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network fault" };
  }
}
