import { useMemo, useState } from "react";
import { useAccount, useBalance, useReadContracts, useSendTransaction, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, parseUnits, erc20Abi } from "viem";
import { Copy as CopyIcon, Check, ArrowUpRight, ShieldAlert } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { USDC } from "../lib/trading/constants";
import { useNotifications } from "../lib/alerts";
import { Panel, Btn, Metric, Tag, cx } from "../components/ui/primitives";
import { WalletButton } from "../components/shell/WalletModal";

/** TREASURY — non-custodial funds operations for the connected wallet.
 *  Deposits arrive at the user's own address; withdrawals are transfers the
 *  user signs. SENTRY never routes value through any intermediary. */

const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;

type Token = "USDC.e" | "USDC" | "POL";

const TOKEN_META: Record<Token, { address?: `0x${string}`; decimals: number; note: string }> = {
  "USDC.e": { address: USDC, decimals: 6, note: "Polymarket settlement collateral" },
  USDC: { address: USDC_NATIVE, decimals: 6, note: "native Circle USDC on Polygon" },
  POL: { decimals: 18, note: "gas token" },
};

const EXCHANGES = [
  { name: "Coinbase", note: "withdraw USDC → Polygon network" },
  { name: "Binance", note: "withdraw USDC → Polygon (POS)" },
  { name: "OKX / Bybit / Kraken", note: "USDC on Polygon supported" },
  { name: "Phantom / MetaMask", note: "in-wallet buy or bridge to Polygon" },
];

export function Treasury() {
  const { address, isConnected } = useAccount();
  const notify = useNotifications((s) => s.push);
  const [copied, setCopied] = useState(false);

  // balances
  const { data: pol } = useBalance({ address, query: { refetchInterval: 20_000 } });
  const tokenReads = useReadContracts({
    contracts: address
      ? [
          { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
          { address: USDC_NATIVE, abi: erc20Abi, functionName: "balanceOf", args: [address] },
        ]
      : [],
    query: { enabled: !!address, refetchInterval: 20_000 },
  });
  const usdceBal = tokenReads.data?.[0]?.result !== undefined ? Number(tokenReads.data[0].result as bigint) / 1e6 : null;
  const usdcBal = tokenReads.data?.[1]?.result !== undefined ? Number(tokenReads.data[1].result as bigint) / 1e6 : null;
  const polBal = pol ? Number(pol.value) / 1e18 : null;

  // withdraw state
  const [token, setToken] = useState<Token>("USDC.e");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const { writeContract, data: erc20Hash, isPending: erc20Pending, error: erc20Err, reset: resetErc20 } = useWriteContract();
  const { sendTransaction, data: nativeHash, isPending: nativePending, error: nativeErr, reset: resetNative } = useSendTransaction();
  const txHash = token === "POL" ? nativeHash : erc20Hash;
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  const balanceOf: Record<Token, number | null> = { "USDC.e": usdceBal, USDC: usdcBal, POL: polBal };
  const bal = balanceOf[token];
  const amountNum = Number(amount) || 0;
  const validRecipient = isAddress(recipient);
  const canReview = isConnected && validRecipient && amountNum > 0 && bal !== null && amountNum <= bal;
  const pending = erc20Pending || nativePending;
  const err = erc20Err || nativeErr;

  const execute = () => {
    if (!validRecipient) return;
    const meta = TOKEN_META[token];
    if (token === "POL") {
      sendTransaction({ to: recipient as `0x${string}`, value: parseUnits(amount, 18) });
    } else {
      writeContract({
        address: meta.address!,
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient as `0x${string}`, parseUnits(amount, meta.decimals)],
      });
    }
    notify({
      kind: "ORDER",
      title: "WITHDRAWAL SUBMITTED",
      body: `${amount} ${token} → ${fmt.shortAddr(recipient)}`,
      href: "/treasury",
    });
    setReviewing(false);
  };

  const copyAddr = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const reset = () => {
    resetErc20();
    resetNative();
    setAmount("");
    setReviewing(false);
  };

  const confirmed = receipt.isSuccess;

  const totalUsd = useMemo(
    () => (usdceBal ?? 0) + (usdcBal ?? 0),
    [usdceBal, usdcBal],
  );

  if (!isConnected) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-4">
        <div className="label">TREASURY REQUIRES A LINKED WALLET</div>
        <p className="max-w-[400px] text-center text-[11.5px] leading-relaxed text-dim">
          Deposits go directly to your own address and withdrawals are transfers you sign.
          Nothing passes through SENTRY.
        </p>
        <WalletButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="hairline-b px-4 py-3">
        <div className="mb-3 flex items-baseline justify-between">
          <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">TREASURY — FUNDS OPERATIONS</h1>
          <span className="label-faint">SELF-CUSTODY · POLYGON</span>
        </div>
        <div className="grid grid-cols-4 gap-6">
          <Metric label="USDC.E — SETTLEMENT" value={usdceBal !== null ? fmt.usd(usdceBal, { compact: false }) : "—"} sub="Polymarket collateral" />
          <Metric label="USDC — NATIVE" value={usdcBal !== null ? fmt.usd(usdcBal, { compact: false }) : "—"} sub="swap to USDC.e to trade" />
          <Metric label="POL — GAS" value={polBal !== null ? polBal.toFixed(4) : "—"} sub="transaction fees" />
          <Metric label="STABLE TOTAL" value={fmt.usd(totalUsd, { compact: false })} tone="accent" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-line p-px">
        {/* DEPOSIT */}
        <Panel className="border-0" title="DEPOSIT — INBOUND CHANNEL">
          <div className="flex flex-col gap-3">
            <div>
              <div className="label-faint mb-1.5">YOUR RECEIVING ADDRESS (POLYGON NETWORK)</div>
              <div className="flex gap-1.5">
                <div className="mono-num flex h-9 min-w-0 flex-1 items-center overflow-hidden border border-line bg-raise2 px-3 text-[11px] text-text">
                  <span className="truncate">{address}</span>
                </div>
                <button
                  onClick={copyAddr}
                  className="focus-outline flex size-9 shrink-0 items-center justify-center border border-line bg-raise2 text-dim transition-colors hover:border-accent/60 hover:text-text"
                  title="Copy address"
                >
                  {copied ? <Check size={13} strokeWidth={1.5} className="text-pos" /> : <CopyIcon size={13} strokeWidth={1.5} />}
                </button>
              </div>
              {copied && <div className="mono-num mt-1 text-[9px] tracking-[0.1em] text-pos">ADDRESS COPIED</div>}
            </div>

            <div className="border border-warn/40 bg-warn/5 px-3 py-2">
              <div className="flex items-center gap-2">
                <ShieldAlert size={12} className="text-warn" strokeWidth={1.5} />
                <span className="label text-warn">NETWORK DISCIPLINE</span>
              </div>
              <ul className="mt-1.5 flex flex-col gap-1 text-[10.5px] leading-relaxed text-dim">
                <li>— Send only on the <span className="text-text">Polygon</span> network.</li>
                <li>— Trading collateral is <span className="text-text">USDC.e (bridged)</span>. Native USDC arriving here can be swapped 1:1 on any Polygon DEX.</li>
                <li>— Keep a small POL balance for gas.</li>
              </ul>
            </div>

            <div>
              <div className="label-faint mb-1.5">FUNDING CHANNELS</div>
              <div className="flex flex-col gap-px bg-line">
                {EXCHANGES.map((e) => (
                  <div key={e.name} className="flex items-center justify-between bg-raise2 px-3 py-2">
                    <span className="text-[11px] text-text">{e.name}</span>
                    <span className="label-faint">{e.note}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="border border-accent/25 bg-accent/[0.04] px-3 py-2">
              <div className="label mb-1 text-accent2">PHANTOM / SOLANA ROUTE — USDC ON SOLANA → POLYGON</div>
              <div className="border border-neg/40 bg-neg/5 px-2 py-1.5 text-[10px] leading-relaxed text-neg2">
                DO NOT USE PHANTOM'S "SEND" — it moves tokens only INSIDE one network. A 0x Polygon
                address is rejected as "Invalid Solana address". Cross-chain requires a BRIDGE.
              </div>
              <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-4 text-[10.5px] leading-relaxed text-dim">
                <li>
                  Open <span className="text-text">JUMPER</span> below (route is pre-filled:
                  Solana USDC → Polygon USDC.e) and connect <span className="text-text">Phantom</span>.
                </li>
                <li>
                  Enter the amount, and under recipient choose{" "}
                  <span className="text-text">"send to a different wallet"</span> → paste your
                  Polygon address from above.
                </li>
                <li>
                  Enable the router's <span className="text-text">gas top-up / refuel</span> so
                  ~0.5 POL arrives with it — approvals and orders need gas.
                </li>
                <li>
                  Confirm in Phantom (a Solana signature). Funds land here in minutes — balances
                  above go live. If native USDC arrives instead of USDC.e, swap 1:1 on a Polygon DEX.
                </li>
              </ol>
              <div className="mt-2 flex gap-1.5">
                {[
                  {
                    name: "USDC ROUTE — PRE-FILLED",
                    href: "https://jumper.exchange/?fromChain=1151111081099710&fromToken=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&toChain=137&toToken=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
                  },
                  {
                    name: "GAS ONLY: SOL → POL",
                    href: "https://jumper.exchange/?fromChain=1151111081099710&fromToken=11111111111111111111111111111111&toChain=137&toToken=0x0000000000000000000000000000000000000000",
                  },
                  { name: "RELAY", href: "https://relay.link/bridge/polygon" },
                  { name: "DEBRIDGE", href: "https://app.debridge.finance" },
                ].map((b) => (
                  <a
                    key={b.name}
                    href={b.href}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-outline flex h-7 items-center gap-1 border border-line bg-raise2 px-2 text-[9px] uppercase tracking-[0.1em] text-dim transition-colors hover:border-accent/60 hover:text-text"
                  >
                    {b.name} <ArrowUpRight size={9} strokeWidth={1.5} />
                  </a>
                ))}
              </div>
            </div>

            <a
              href={`https://polygonscan.com/address/${address}`}
              target="_blank"
              rel="noreferrer"
              className="label-faint flex items-center gap-1 hover:text-dim"
            >
              VERIFY ON POLYGONSCAN <ArrowUpRight size={10} strokeWidth={1.5} />
            </a>
          </div>
        </Panel>

        {/* WITHDRAW */}
        <Panel className="border-0" title="WITHDRAW — OUTBOUND TRANSFER">
          {confirmed && txHash ? (
            <div className="border border-pos/40 bg-pos/5 p-3">
              <div className="label text-pos">WITHDRAWAL CONFIRMED ON-CHAIN</div>
              <div className="mono-num mt-2 break-all text-[10px] text-dim">{txHash}</div>
              <div className="mt-2 flex items-center gap-2">
                <a
                  href={`https://polygonscan.com/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="label flex items-center gap-1 text-accent2 hover:opacity-80"
                >
                  VIEW TRANSACTION <ArrowUpRight size={10} strokeWidth={1.5} />
                </a>
                <Btn size="sm" variant="ghost" onClick={reset} className="ml-auto">
                  NEW TRANSFER
                </Btn>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <div className="label-faint mb-1.5">ASSET</div>
                <div className="grid grid-cols-3 gap-px bg-line">
                  {(Object.keys(TOKEN_META) as Token[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setToken(t)}
                      className={cx(
                        "focus-outline flex h-9 flex-col items-center justify-center transition-colors",
                        token === t ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                      )}
                    >
                      <span className="text-[10.5px] font-medium tracking-[0.08em]">{t}</span>
                      <span className="mono-num text-[8.5px] text-faint">
                        {balanceOf[t] !== null ? (t === "POL" ? balanceOf[t]!.toFixed(3) : fmt.usd(balanceOf[t]!, { compact: false })) : "—"}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="label-faint mt-1">{TOKEN_META[token].note.toUpperCase()}</div>
              </div>

              <div>
                <div className="label-faint mb-1.5">RECIPIENT ADDRESS</div>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                  placeholder="0x…"
                  className="focus-outline mono-num h-9 w-full border border-line bg-raise2 px-3 text-[11.5px] text-text placeholder:text-faint"
                />
                {recipient && !validRecipient && (
                  <div className="mt-1 text-[9.5px] uppercase tracking-[0.1em] text-warn2">NOT A VALID EVM ADDRESS</div>
                )}
              </div>

              <div>
                <div className="label-faint mb-1.5">AMOUNT</div>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="focus-outline mono-num h-9 flex-1 border border-line bg-raise2 px-3 text-[14px] text-text placeholder:text-faint"
                  />
                  <Btn
                    size="lg"
                    onClick={() => bal !== null && setAmount(token === "POL" ? Math.max(0, bal - 0.05).toFixed(4) : bal.toFixed(2))}
                  >
                    MAX
                  </Btn>
                </div>
                {bal !== null && amountNum > bal && (
                  <div className="mt-1 text-[9.5px] uppercase tracking-[0.1em] text-warn2">EXCEEDS AVAILABLE BALANCE</div>
                )}
              </div>

              {!reviewing ? (
                <Btn variant="accent" size="lg" disabled={!canReview} onClick={() => setReviewing(true)}>
                  REVIEW TRANSFER
                </Btn>
              ) : (
                <div className="border border-accent/40 bg-accent/5 p-3">
                  <div className="label text-accent2">CONFIRM OUTBOUND TRANSFER</div>
                  <div className="mono-num mt-2 flex flex-col gap-1 text-[11px] text-dim">
                    <span>SEND — <span className="text-text">{amount} {token}</span></span>
                    <span>TO — <span className="text-text">{recipient}</span></span>
                    <span className="text-warn2">TRANSFERS ARE IRREVERSIBLE. VERIFY THE ADDRESS.</span>
                  </div>
                  <div className="mt-3 flex gap-1.5">
                    <Btn variant="yes" size="lg" className="flex-1" disabled={pending} onClick={execute}>
                      {pending ? "AWAITING SIGNATURE…" : "SIGN & BROADCAST"}
                    </Btn>
                    <Btn size="lg" variant="ghost" onClick={() => setReviewing(false)}>
                      ABORT
                    </Btn>
                  </div>
                </div>
              )}

              {txHash && !confirmed && (
                <div className="border border-line bg-raise2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Tag tone="accent">BROADCAST</Tag>
                    <span className="label-faint">AWAITING CONFIRMATION</span>
                    <a
                      href={`https://polygonscan.com/tx/${txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="label-faint ml-auto flex items-center gap-1 hover:text-dim"
                    >
                      TRACK <ArrowUpRight size={10} strokeWidth={1.5} />
                    </a>
                  </div>
                </div>
              )}

              {err && (
                <div className="border border-neg/40 bg-neg/5 px-2.5 py-2 text-[10.5px] leading-relaxed text-neg2">
                  TRANSFER FAULT — {err.message.split("\n")[0]}
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
