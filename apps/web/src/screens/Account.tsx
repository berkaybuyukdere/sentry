import { Link } from "react-router-dom";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { erc20Abi } from "viem";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { USDC } from "../lib/trading/constants";
import { useBilling, tierById, bpsPct } from "../lib/billing";
import { useSession } from "../lib/session";
import { useWatchlists } from "../lib/watchlists";
import { useCopy } from "../lib/copy";
import { useRules } from "../lib/alerts";
import { useOrderLog } from "../lib/trading/orderLog";
import { cachedCreds, clearCreds } from "../lib/trading/clobAuth";
import { Panel, Btn, Metric, Tag } from "../components/ui/primitives";
import { WalletButton } from "../components/shell/WalletModal";

export function Account() {
  const { callsign, authedAt, terminate } = useSession();
  const { address, isConnected, connector } = useAccount();
  const lists = useWatchlists((s) => s.lists);
  const strategies = useCopy((s) => s.strategies);
  const rules = useRules((s) => s.rules);
  const orders = useOrderLog((s) => s.orders);
  const creds = address ? cachedCreds(address) : null;
  const billingTier = useBilling((s) => s.tier);
  const ledger = useBilling((s) => s.ledger);
  const tierDef = tierById(billingTier);
  const fees30d = ledger.filter((l) => l.ts > Date.now() - 30 * 86400_000).reduce((s, l) => s + l.feeUsd, 0);
  const { data: pol } = useBalance({ address, query: { refetchInterval: 30_000 } });
  const tokenReads = useReadContracts({
    contracts: address ? [{ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }] : [],
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const usdce = tokenReads.data?.[0]?.result !== undefined ? Number(tokenReads.data[0].result as bigint) / 1e6 : null;

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">OPERATOR ACCOUNT</h1>
      </div>
      <div className="grid max-w-[980px] grid-cols-2 gap-px bg-line p-px">
        <Panel className="border-0" title="ANONYMOUS IDENTITY">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4">
              <Metric label="CALLSIGN" value={callsign ?? "—"} />
              <Metric
                label="SESSION ESTABLISHED"
                value={authedAt ? new Date(authedAt).toISOString().slice(0, 10) : "—"}
              />
            </div>
            <p className="text-[10.5px] leading-relaxed text-faint">
              Zero PII by design: no email, no phone, no registration. The callsign is generated
              locally; workspace state (watchlists, strategies, rules, order log) persists only in
              this browser. No server-side account exists.
            </p>
            <Btn
              variant="ghost"
              className="self-start"
              onClick={() => {
                const buf = new Uint8Array(2);
                crypto.getRandomValues(buf);
                useSession.getState().authenticate(
                  `OP-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`,
                );
              }}
            >
              REGENERATE CALLSIGN
            </Btn>
            <Btn variant="danger" onClick={terminate} className="self-start">
              TERMINATE SESSION
            </Btn>
          </div>
        </Panel>

        <Panel className="border-0" title="TRADING IDENTITY">
          <div className="flex flex-col gap-3">
            {isConnected ? (
              <>
                <div>
                  <div className="label-faint">LINKED WALLET</div>
                  <div className="mono-num mt-1 text-[11.5px] text-text">{address}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Tag tone="pos">CONNECTED</Tag>
                    <span className="label-faint">{connector?.name}</span>
                  </div>
                </div>
                <div>
                  <div className="label-faint">CLOB API CREDENTIAL</div>
                  <div className="mt-1 flex items-center gap-2">
                    {creds ? (
                      <>
                        <span className="mono-num text-[10.5px] text-dim">{creds.apiKey.slice(0, 18)}…</span>
                        <Btn size="sm" variant="ghost" onClick={() => { clearCreds(address!); location.reload(); }}>
                          REVOKE LOCAL CREDENTIAL
                        </Btn>
                      </>
                    ) : (
                      <span className="text-[10.5px] text-faint">
                        Derived on first order via EIP-712 attestation. Never leaves this browser.
                      </span>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="text-[11px] text-dim">No wallet linked. Trading requires your own Polygon wallet.</p>
                <WalletButton />
              </>
            )}
          </div>
        </Panel>

        <Panel className="border-0" title="FUNDS — QUICK OPERATIONS">
          {isConnected ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-4">
                <Metric label="USDC.E — SETTLEMENT" value={usdce !== null ? fmt.usd(usdce, { compact: false }) : "—"} />
                <Metric label="POL — GAS" value={pol ? (Number(pol.value) / 1e18).toFixed(4) : "—"} />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <Link
                  to="/treasury"
                  className="focus-outline flex h-9 items-center justify-center gap-2 border border-pos/50 bg-pos/10 text-[10.5px] font-medium uppercase tracking-[0.12em] text-pos2 transition-colors hover:bg-pos/20"
                >
                  <ArrowDownToLine size={12} strokeWidth={1.5} /> DEPOSIT
                </Link>
                <Link
                  to="/treasury"
                  className="focus-outline flex h-9 items-center justify-center gap-2 border border-line-strong bg-raise2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-text transition-colors hover:border-line-hover"
                >
                  <ArrowUpFromLine size={12} strokeWidth={1.5} /> WITHDRAW
                </Link>
              </div>
              <span className="label-faint">FULL FUNDS TERMINAL — PORTFOLIO → TREASURY</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-dim">Link a wallet to operate funds. Deposits land at your own address; withdrawals are transfers you sign.</p>
              <WalletButton />
            </div>
          )}
        </Panel>

        <Panel className="border-0" title="ACCESS TIER — BILLING">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4">
              <Metric label="CURRENT TIER" value={tierDef.name} tone={billingTier !== "ACCESS" ? "accent" : undefined} sub={`$${tierDef.monthlyUsd}/month`} />
              <Metric label="EXECUTION FEES — 30D" value={fmt.usd(fees30d, { compact: false })} sub={`${ledger.length} executions accrued`} />
            </div>
            <div className="mono-num flex gap-4 text-[10px] text-faint">
              <span>MANUAL {bpsPct(tierDef.rates.MANUAL)}</span>
              <span>SIGNAL {bpsPct(tierDef.rates.SIGNAL)}</span>
              <span>COPY {bpsPct(tierDef.rates.COPY)}</span>
            </div>
            <Link
              to="/pricing"
              className="focus-outline flex h-8 items-center justify-center border border-accent/60 bg-accent/10 text-[10px] font-medium uppercase tracking-[0.14em] text-accent2 transition-colors hover:bg-accent/20"
            >
              MANAGE ACCESS TIER
            </Link>
          </div>
        </Panel>

        <Panel className="col-span-2 border-0" title="WORKSPACE FOOTPRINT">
          <div className="grid grid-cols-4 gap-6">
            <Metric label="WATCHLISTS" value={lists.length} sub={`${lists.reduce((n, l) => n + l.markets.length, 0)} markets tracked`} />
            <Metric label="COPY STRATEGIES" value={strategies.length} sub={`${strategies.filter((s) => s.active).length} active`} />
            <Metric label="MONITORING RULES" value={rules.length} sub={`${rules.filter((r) => r.active).length} armed`} />
            <Metric label="ORDERS LOGGED" value={orders.length} sub={orders[0] ? `last ${fmt.timeAgo(Math.floor(orders[0].ts / 1000))} ago` : "none yet"} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
