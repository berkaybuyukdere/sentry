import { useMemo } from "react";
import { useAccount, useBalance, useReadContracts, useWriteContract } from "wagmi";
import { maxUint256 } from "viem";
import {
  USDC,
  CTF,
  CTF_EXCHANGE,
  NEG_RISK_EXCHANGE,
  NEG_RISK_ADAPTER,
  ERC20_ABI,
  CTF_ABI,
} from "./constants";

/**
 * On-chain trading provisioning for a direct EOA maker:
 * USDC allowances to both exchanges + adapter, CTF operator approval for both
 * exchanges. All six must be granted once before the CLOB will settle fills.
 */

export interface ProvisionStep {
  key: string;
  label: string;
  granted: boolean;
  execute: () => void;
}

export function useProvision() {
  const { address } = useAccount();
  const { writeContract, isPending } = useWriteContract();
  // native POL — without gas every approval/order settlement reverts in the
  // wallet's simulator ("Failed to simulate"), so it gates the whole flow
  const polRead = useBalance({ address, query: { enabled: !!address, refetchInterval: 20_000 } });
  const polBalance = polRead.data ? Number(polRead.data.value) / 1e18 : null;

  const reads = useReadContracts({
    contracts: address
      ? [
          { address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [address] },
          { address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [address, CTF_EXCHANGE] },
          { address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [address, NEG_RISK_EXCHANGE] },
          { address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [address, NEG_RISK_ADAPTER] },
          { address: CTF, abi: CTF_ABI, functionName: "isApprovedForAll", args: [address, CTF_EXCHANGE] },
          { address: CTF, abi: CTF_ABI, functionName: "isApprovedForAll", args: [address, NEG_RISK_EXCHANGE] },
        ]
      : [],
    query: { enabled: !!address, refetchInterval: 20_000 },
  });

  const r = reads.data;
  const usdcBalance = r?.[0]?.result !== undefined ? Number(r[0].result as bigint) / 1e6 : null;

  const steps: ProvisionStep[] = useMemo(() => {
    if (!address) return [];
    const allow = (i: number) => ((r?.[i]?.result as bigint | undefined) ?? 0n) > 0n;
    const approved = (i: number) => (r?.[i]?.result as boolean | undefined) === true;
    const approveUsdc = (spender: `0x${string}`) => () =>
      writeContract({ address: USDC, abi: ERC20_ABI, functionName: "approve", args: [spender, maxUint256] });
    const approveCtf = (operator: `0x${string}`) => () =>
      writeContract({ address: CTF, abi: CTF_ABI, functionName: "setApprovalForAll", args: [operator, true] });
    return [
      { key: "usdc-exchange", label: "USDC → CTF EXCHANGE", granted: allow(1), execute: approveUsdc(CTF_EXCHANGE) },
      { key: "usdc-negrisk", label: "USDC → NEG-RISK EXCHANGE", granted: allow(2), execute: approveUsdc(NEG_RISK_EXCHANGE) },
      { key: "usdc-adapter", label: "USDC → NEG-RISK ADAPTER", granted: allow(3), execute: approveUsdc(NEG_RISK_ADAPTER) },
      { key: "ctf-exchange", label: "CTF → CTF EXCHANGE", granted: approved(4), execute: approveCtf(CTF_EXCHANGE) },
      { key: "ctf-negrisk", label: "CTF → NEG-RISK EXCHANGE", granted: approved(5), execute: approveCtf(NEG_RISK_EXCHANGE) },
    ];
  }, [address, r, writeContract]);

  const provisioned = steps.length > 0 && steps.every((s) => s.granted);

  return {
    usdcBalance,
    polBalance,
    /** enough native POL to pay for an approval / settlement transaction */
    gasReady: polBalance !== null && polBalance >= 0.01,
    steps,
    provisioned,
    loading: reads.isLoading,
    approving: isPending,
    refetch: reads.refetch,
  };
}
