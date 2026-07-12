import { createConfig, http, fallback } from "wagmi";
import { polygon } from "wagmi/chains";
import { injected, metaMask, coinbaseWallet, walletConnect } from "wagmi/connectors";

/**
 * Wallet surface: EIP-6963 multi-provider discovery is enabled by default, so
 * every installed announcing wallet (Phantom, MetaMask, Rabby, OKX, Backpack,
 * Zerion, …) appears automatically. Explicit connectors below guarantee
 * MetaMask + Coinbase entries even without an injected provider, and
 * WalletConnect unlocks every mobile wallet when a project id is supplied.
 */

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

export const wagmiConfig = createConfig({
  chains: [polygon],
  connectors: [
    injected(),
    metaMask({ dappMetadata: { name: "SENTRY" } }),
    coinbaseWallet({ appName: "SENTRY" }),
    ...(wcProjectId
      ? [
          walletConnect({
            projectId: wcProjectId,
            metadata: {
              name: "SENTRY",
              description: "Prediction market intelligence terminal",
              url: "https://localhost",
              icons: [],
            },
          }),
        ]
      : []),
  ],
  multiInjectedProviderDiscovery: true,
  transports: {
    // polygon-rpc.com began returning 401s — resilient fallback chain
    [polygon.id]: fallback([
      http("https://polygon-bor-rpc.publicnode.com"),
      http("https://1rpc.io/matic"),
      http("https://polygon.drpc.org"),
    ]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
