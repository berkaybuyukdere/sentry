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

interface ApiAccessState {
  clob: ImportedClob | null;
  builder: BuilderKey | null;
  setClob: (c: ImportedClob | null) => void;
  setBuilder: (b: BuilderKey | null) => void;
}

export const useApiAccess = create<ApiAccessState>()(
  persist(
    (set) => ({
      clob: null,
      builder: null,
      setClob: (clob) => set({ clob: clob ? { ...clob, address: clob.address.toLowerCase() } : null }),
      setBuilder: (builder) => set({ builder }),
    }),
    { name: "sentry.apiAccess" },
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
