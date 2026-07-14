import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { CTF } from "./constants";

/**
 * Ground-truth position size. LiveExecution.shares is a LEDGER value derived
 * from order responses — if any prior recording bug ever overstated it (the
 * legacy ticket path logged the pre-trade REQUESTED size, not the confirmed
 * fill — fixed alongside this file), a SELL sized off the ledger requests
 * more than the wallet actually holds and the CLOB rejects it forever
 * ("not enough balance"). Every exit reconciles against this before signing.
 *
 * Polymarket outcome tokens are Gnosis Conditional Tokens (ERC-1155),
 * 6-decimal-scaled to match USDC.e/pUSD (1 share = 1e6 units).
 */

const publicClient = createPublicClient({
  chain: polygon,
  transport: http("https://polygon-bor-rpc.publicnode.com"),
});

const ERC1155_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function readCtfShareBalance(owner: `0x${string}`, tokenId: string): Promise<number> {
  const raw = await publicClient.readContract({
    address: CTF,
    abi: ERC1155_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner, BigInt(tokenId)],
  });
  return Number(raw) / 1e6;
}
