import type { WalletClient } from "viem";
import { CHAIN_ID, CLOB_HOST } from "./constants";

/**
 * Polymarket CLOB authentication.
 * L1: EIP-712 attestation signed by the user's wallet, exchanged for API credentials.
 * L2: HMAC-SHA256 request signing with those credentials.
 * Credentials never leave the browser; they are cached per-address in localStorage.
 */

export interface ClobCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

const CRED_KEY = (addr: string) => `sentry.clobCreds.${addr.toLowerCase()}`;

export function cachedCreds(address: string): ClobCreds | null {
  try {
    const raw = localStorage.getItem(CRED_KEY(address));
    return raw ? (JSON.parse(raw) as ClobCreds) : null;
  } catch {
    return null;
  }
}

export function clearCreds(address: string) {
  localStorage.removeItem(CRED_KEY(address));
}

async function signClobAuth(wallet: WalletClient, address: `0x${string}`, timestamp: string) {
  return wallet.signTypedData({
    account: address,
    domain: { name: "ClobAuthDomain", version: "1", chainId: CHAIN_ID },
    types: {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    message: {
      address,
      timestamp,
      nonce: 0n,
      message: "This message attests that I control the given wallet",
    },
  });
}

/** Derive (or create) CLOB API credentials for the connected wallet. */
export async function ensureCreds(wallet: WalletClient, address: `0x${string}`): Promise<ClobCreds> {
  const cached = cachedCreds(address);
  if (cached) return cached;

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signClobAuth(wallet, address, timestamp);
  const headers = {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: "0",
  };

  let res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, { headers });
  if (!res.ok) {
    res = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "POST", headers });
  }
  if (!res.ok) {
    throw new Error(`CLOB credential handshake failed (${res.status})`);
  }
  const creds = (await res.json()) as ClobCreds;
  if (!creds.apiKey || !creds.secret) throw new Error("CLOB returned incomplete credentials");
  localStorage.setItem(CRED_KEY(address), JSON.stringify(creds));
  return creds;
}

// --- L2 request signing --------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256B64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_");
}

export async function l2Headers(
  address: string,
  creds: ClobCreds,
  method: string,
  requestPath: string,
  body?: string,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${timestamp}${method}${requestPath}${body ?? ""}`;
  const signature = await hmacSha256B64Url(creds.secret, message);
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

export async function clobAuthed<T>(
  address: string,
  creds: ClobCreds,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const headers = await l2Headers(address, creds, method, path, bodyStr);
  const res = await fetch(`${CLOB_HOST}${path}`, {
    method,
    headers: { ...headers, ...(bodyStr ? { "Content-Type": "application/json" } : {}) },
    body: bodyStr,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (json as { error?: string; errorMsg?: string }).error ??
      (json as { errorMsg?: string }).errorMsg ??
      `CLOB ${method} ${path} → ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}
