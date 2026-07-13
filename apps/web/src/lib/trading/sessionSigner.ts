import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createWalletClient, getAddress, http, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

/**
 * AUTOPILOT SIGNER — a dedicated trading key that signs CLOB v2 orders
 * programmatically so Phantom never prompts during a LIVE session.
 *
 * WHY: CLOB v2 orders are EIP-712 signatures. As long as the signing key
 * lives inside a browser-extension wallet, every order pops a confirmation —
 * that is the extension's security model and cannot be disabled. The only
 * clean path to full autopilot is a key SENTRY itself can use.
 *
 * SECURITY MODEL (deliberate, at the operator's explicit request):
 * - The key is generated locally and stored ONLY in this browser's
 *   localStorage. It never leaves the machine; there is no server.
 * - This is a HOT KEY. Anyone with access to this browser profile (or a
 *   future XSS in a dependency) could extract it. Keep ONLY the trading
 *   bankroll on it — never park serious funds here.
 * - The main wallet (Phantom) remains untouched and remains the treasury.
 *
 * ONE-TIME SETUP (mirrors the hard-won main-account chase, v14→v21):
 * the session account needs its own Polymarket-side identity — import the
 * key into Phantom once, log in at polymarket.com, deposit (deploys its
 * proxy wallet + converts to pUSD), copy the profile "Copy address" proxy
 * into SENTRY. After that the key signs everything silently.
 */

interface SessionSignerState {
  pk: `0x${string}` | null;
  /** the session account's Polymarket proxy wallet — pasted from the
   *  polymarket.com profile "Copy address" (NEVER guessed; v21 lesson) */
  proxyWallet: `0x${string}` | null;
  /** master switch — the desk only signs with the key while this is on */
  enabled: boolean;
  generate: () => `0x${string}`;
  importKey: (pk: string) => `0x${string}` | null;
  setProxyWallet: (a: string) => boolean;
  setEnabled: (v: boolean) => void;
  clear: () => void;
}

export const useSessionSigner = create<SessionSignerState>()(
  persist(
    (set, get) => ({
      pk: null,
      proxyWallet: null,
      enabled: false,

      generate: () => {
        const pk = generatePrivateKey();
        set({ pk, enabled: false, proxyWallet: null });
        return privateKeyToAccount(pk).address;
      },

      importKey: (raw) => {
        const pk = (raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`) as `0x${string}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
        try {
          const address = privateKeyToAccount(pk).address;
          set({ pk, enabled: false, proxyWallet: null });
          return address;
        } catch {
          return null;
        }
      },

      setProxyWallet: (a) => {
        // getAddress checksums (and REJECTS mixed-case typos) — a mistyped
        // proxy here silently reroutes every order to a wallet with $0
        try {
          set({ proxyWallet: getAddress(a.trim()) });
          return true;
        } catch {
          return false;
        }
      },

      setEnabled: (enabled) => {
        const { pk, proxyWallet } = get();
        set({ enabled: enabled && !!pk && !!proxyWallet });
      },

      clear: () => set({ pk: null, proxyWallet: null, enabled: false }),
    }),
    { name: "sentry.sessionSigner" },
  ),
);

export function sessionAddress(): `0x${string}` | null {
  const { pk } = useSessionSigner.getState();
  return pk ? privateKeyToAccount(pk).address : null;
}

let cachedClient: { pk: string; client: WalletClient } | null = null;

/** WalletClient backed by the session key — drop-in for the wagmi client in
 *  signAndPlaceOrder/getV2Client; signs EIP-712 with zero user interaction. */
export function sessionWalletClient(): WalletClient | null {
  const { pk } = useSessionSigner.getState();
  if (!pk) return null;
  if (cachedClient?.pk === pk) return cachedClient.client;
  const client = createWalletClient({
    account: privateKeyToAccount(pk),
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  });
  cachedClient = { pk, client };
  return client;
}

/** true when the desk can sign without the extension wallet */
export function autopilotReady(): boolean {
  const s = useSessionSigner.getState();
  return s.enabled && !!s.pk && !!s.proxyWallet;
}
