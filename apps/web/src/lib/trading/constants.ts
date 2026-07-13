/** Polygon mainnet contract surface for Polymarket's CLOB settlement. */

export const CHAIN_ID = 137;

export const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const; // USDC.e (6 decimals)
export const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const; // pUSD — CLOB v2 native collateral (6 decimals)
export const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const; // Conditional Tokens

export const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
export const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const;
export const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Operator-specific wallets (baked; single-operator terminal — same policy as
// the baked API keys in apiAccess.ts). Found by direct on-chain verification
// after two wrong guesses — see sentry-terminal.md memory for the full chase:
//   1. 0x0947b5…3514 (SDK self-derived) — had pUSD allowance but $0 pUSD balance
//   2. 0x1F6F8d…9886 ("Transfer Crypto" modal address) — $0 on both tokens
//   3. 0x5b3587…aba69 (THIS ONE) — copied from the user's own Polymarket
//      profile page ("Copy address" on polymarket.com/@sentinelbb) — confirmed
//      on-chain: pUSD balance $19.03 (matches site's Cash exactly) AND already
//      carries a maxed pUSD allowance to the v2 exchange. This is the real,
//      persistent Polymarket proxy/trading wallet for the operator's account.
export const POLY_PROXY_WALLET = "0x5b3587e9c0650b1148d8419213c7a90ad96aba69" as const;
// LEGACY_DEPOSIT_WALLET — the beta client's own depositWalletFactory
// derivation (createSecureClient with `wallet` omitted) — a DIFFERENT wallet
// the consumer site never recognized. Kept only so the recovery flow can
// pull back anything accidentally parked there again.
export const LEGACY_DEPOSIT_WALLET = "0x0947b5923e2b8855045dc6de4519f1cdbcb73514" as const;

export const CLOB_HOST = "https://clob.polymarket.com";

export const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const CTF_ABI = [
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;
