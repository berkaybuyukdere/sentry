import type { ApiKeyAuthorization } from "@polymarket/client";

/**
 * Browser port of `@polymarket/client/node`'s `builderApiKey`.
 *
 * The official factory is gated behind a Node-runtime invariant purely as a
 * policy guard (builder secrets don't belong in multi-user web apps). SENTRY
 * is a single-operator terminal running the operator's OWN builder key, so
 * the same authorization — POLY_BUILDER_* headers with an HMAC-SHA256 over
 * `${timestamp}${method}${path}${body}` — is reproduced here byte-for-byte
 * using WebCrypto (which is exactly what the upstream implementation uses).
 *
 * Why this exists: the relayer rejects personal Relayer API keys for
 * transactions whose `from` is not the key's own bound address ("from 0x…
 * does not match auth 0x…"). Deploying/settling the user's Deposit Wallet
 * needs BUILDER-tier authorization, which may act on behalf of any user.
 */

export interface BuilderApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

function b64ToBuf(b64: string): ArrayBuffer {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function hmacB64Url(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    b64ToBuf(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

interface AuthorizeRequest {
  method: string;
  path: string;
  body?: string;
}

class BrowserBuilderApiKey {
  #creds: BuilderApiKeyCreds;

  constructor(creds: BuilderApiKeyCreds) {
    this.#creds = creds;
  }

  get isBuilderKey(): boolean {
    return true;
  }

  get supportGasless(): boolean {
    return true;
  }

  async authorize(request: AuthorizeRequest): Promise<Record<string, string>> {
    const ts = Math.floor(Date.now() / 1000);
    let message = `${ts}${request.method}${request.path}`;
    if (request.body !== undefined) message += request.body;
    return {
      POLY_BUILDER_API_KEY: this.#creds.key,
      POLY_BUILDER_PASSPHRASE: this.#creds.passphrase,
      POLY_BUILDER_SIGNATURE: await hmacB64Url(this.#creds.secret, message),
      POLY_BUILDER_TIMESTAMP: `${ts}`,
    };
  }
}

export function builderApiKeyBrowser(creds: BuilderApiKeyCreds): ApiKeyAuthorization {
  return new BrowserBuilderApiKey(creds) as unknown as ApiKeyAuthorization;
}
