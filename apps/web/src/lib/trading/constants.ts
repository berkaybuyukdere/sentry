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
// the baked API keys in apiAccess.ts):
// POLY_PROXY_WALLET — polymarket.com's own proxy for the operator's EOA
// (0xd99b…1827). The website deposits/converts/trades through THIS address;
// the v2 client must use the same one or balances live in two different
// invisible places (learned the hard way — see LEGACY_DEPOSIT_WALLET).
export const POLY_PROXY_WALLET = "0x1F6F8d1f06ec5dC4B575b33ECa448f3466F79886" as const;
// LEGACY_DEPOSIT_WALLET — the beta client's own depositWalletFactory
// derivation (createSecureClient with `wallet` omitted). $18.96 USDC.e was
// parked here on 2026-07-13; kept only so the recovery flow can pull it back.
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
