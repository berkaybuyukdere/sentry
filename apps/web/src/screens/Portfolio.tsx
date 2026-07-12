import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { fmt, domainKeyFromTitle } from "@sentry-app/polymarket";
import { usePositions, useWalletValue } from "../lib/queries";
import { useProvision } from "../lib/trading/provision";
import { Panel, Metric, Loading, Empty, cx } from "../components/ui/primitives";
import { WalletButton } from "../components/shell/WalletModal";

/** Institutional portfolio & risk view for the connected wallet. */
export function Portfolio() {
  const { address, isConnected } = useAccount();
  const addr = address?.toLowerCase();
  const { data: positions, isLoading } = usePositions(addr);
  const { data: value } = useWalletValue(addr);
  const { usdcBalance } = useProvision();
  const navigate = useNavigate();

  const analysis = useMemo(() => {
    if (!positions?.length) return null;
    const exposure = positions.reduce((s, p) => s + p.currentValue, 0);
    const unrealized = positions.reduce((s, p) => s + p.cashPnl, 0);
    const initial = positions.reduce((s, p) => s + p.initialValue, 0);

    const byDomain = new Map<string, number>();
    const byOutcome = { yes: 0, no: 0 };
    for (const p of positions) {
      const d = domainKeyFromTitle(p.title);
      byDomain.set(d, (byDomain.get(d) ?? 0) + p.currentValue);
      if (p.outcomeIndex === 0) byOutcome.yes += p.currentValue;
      else byOutcome.no += p.currentValue;
    }

    // correlated exposure: positions sharing an event
    const byEvent = new Map<string, { titles: string[]; value: number; slug: string }>();
    for (const p of positions) {
      const key = p.eventSlug || p.slug;
      const e = byEvent.get(key) ?? { titles: [], value: 0, slug: key };
      e.titles.push(`${p.title} — ${p.outcome}`);
      e.value += p.currentValue;
      byEvent.set(key, e);
    }
    const correlated = [...byEvent.values()]
      .filter((e) => e.titles.length > 1)
      .sort((a, b) => b.value - a.value);

    const largestShare = exposure > 0 ? Math.max(...positions.map((p) => p.currentValue)) / exposure : 0;
    const domainShares = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);
    const topDomainShare = exposure > 0 && domainShares.length ? domainShares[0][1] / exposure : 0;
    const riskScore = Math.round(
      Math.min(10, largestShare * 8 + topDomainShare * 4 + (correlated.length ? 2 : 0)),
    );

    return { exposure, unrealized, initial, byDomain: domainShares, byOutcome, correlated, riskScore };
  }, [positions]);

  if (!isConnected) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-4">
        <div className="label">PORTFOLIO REQUIRES A LINKED WALLET</div>
        <p className="max-w-[380px] text-center text-[11.5px] leading-relaxed text-dim">
          Positions, exposure and risk are read directly from your wallet's on-chain state.
          SENTRY never takes custody.
        </p>
        <WalletButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="hairline-b px-4 py-3">
        <div className="mb-3 flex items-baseline justify-between">
          <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">PORTFOLIO — RISK TERMINAL</h1>
          <span className="mono-num text-[10px] text-faint">{addr}</span>
        </div>
        <div className="grid grid-cols-6 gap-6">
          <Metric label="POSITION VALUE" value={value !== undefined ? fmt.usd(value) : "—"} />
          <Metric label="AVAILABLE USDC" value={usdcBalance !== null ? fmt.usd(usdcBalance) : "—"} />
          <Metric label="OPEN EXPOSURE" value={analysis ? fmt.usd(analysis.exposure) : "$0"} sub={positions ? `${positions.length} positions` : undefined} />
          <Metric
            label="UNREALIZED P&L"
            value={analysis ? fmt.usd(analysis.unrealized, { sign: true }) : "$0"}
            tone={analysis && analysis.unrealized >= 0 ? "pos" : "neg"}
          />
          <Metric
            label="OPEN ROI"
            value={analysis && analysis.initial > 0 ? fmt.pct(analysis.unrealized / analysis.initial, 1) : "—"}
            tone={analysis && analysis.unrealized >= 0 ? "pos" : "neg"}
          />
          <Metric
            label="RISK SCORE"
            value={analysis ? `${analysis.riskScore}/10` : "—"}
            tone={analysis && analysis.riskScore >= 7 ? "warn" : undefined}
            sub="concentration-weighted"
          />
        </div>
      </div>

      {isLoading ? (
        <Loading label="READING ON-CHAIN POSITIONS" className="h-40" />
      ) : !positions?.length ? (
        <Empty label="NO OPEN POSITIONS" hint="Executed positions will appear here immediately." />
      ) : (
        <div className="grid grid-cols-3 gap-px bg-line p-px">
          <Panel className="border-0" title="EXPOSURE BY DOMAIN">
            <div className="flex flex-col gap-2">
              {analysis!.byDomain.map(([d, v]) => (
                <div key={d} className="flex items-center gap-2">
                  <span className="label w-14 shrink-0">{d}</span>
                  <div className="h-[5px] flex-1 bg-raise3">
                    <div className="h-full bg-accent/70" style={{ width: `${(v / analysis!.exposure) * 100}%` }} />
                  </div>
                  <span className="mono-num w-14 text-right text-[10.5px] text-dim">{fmt.usd(v)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel className="border-0" title="EXPOSURE BY OUTCOME SIDE">
            <div className="flex flex-col gap-3">
              {(
                [
                  ["PRIMARY (YES-SIDE)", analysis!.byOutcome.yes, "bg-pos/70"],
                  ["COUNTER (NO-SIDE)", analysis!.byOutcome.no, "bg-neg/70"],
                ] as const
              ).map(([label, v, color]) => (
                <div key={label}>
                  <div className="flex justify-between">
                    <span className="label-faint">{label}</span>
                    <span className="mono-num text-[11px] text-text">{fmt.usd(v)}</span>
                  </div>
                  <div className="mt-1 h-[5px] bg-raise3">
                    <div className={cx("h-full", color)} style={{ width: `${(v / Math.max(analysis!.exposure, 1)) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel className="border-0" title="CORRELATED EXPOSURE">
            {!analysis!.correlated.length ? (
              <Empty label="NO STACKED EVENT RISK" hint="No two positions share a resolving event." />
            ) : (
              <div className="flex flex-col gap-2.5">
                {analysis!.correlated.slice(0, 3).map((c) => (
                  <div key={c.slug} className="border border-warn/40 bg-warn/5 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="label text-warn">CORRELATION WARNING</span>
                      <span className="mono-num text-[10px] text-warn2">
                        {fmt.pct(c.value / analysis!.exposure, 0)} OF EXPOSURE
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-col gap-0.5">
                      {c.titles.slice(0, 4).map((t) => (
                        <span key={t} className="truncate text-[10.5px] text-dim">— {t}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="col-span-3 border-0" title="OPEN POSITIONS" pad={false}>
            <table className="w-full">
              <thead>
                <tr className="hairline-b">
                  <th className="label-faint px-3 py-1.5 text-left font-medium">MARKET</th>
                  <th className="label-faint px-2 py-1.5 text-left font-medium">SIDE</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">SHARES</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">ENTRY → MARK</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">COST</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">VALUE</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">P&L</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">RESOLVES</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr
                    key={p.asset}
                    onClick={() => navigate(`/market/${p.slug}`)}
                    className="hairline-b h-9 cursor-pointer row-hover"
                  >
                    <td className="max-w-0 truncate px-3 text-[11.5px] text-text">{p.title}</td>
                    <td className="px-2">
                      <span className={cx("text-[10px] font-semibold", p.outcomeIndex === 0 ? "text-pos" : "text-neg")}>
                        {p.outcome.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono-num px-2 text-right text-[10.5px] text-dim">{fmt.num(p.size)}</td>
                    <td className="mono-num px-2 text-right text-[10.5px] text-dim">
                      {(p.avgPrice * 100).toFixed(1)}¢ → {(p.curPrice * 100).toFixed(1)}¢
                    </td>
                    <td className="mono-num px-2 text-right text-[10.5px] text-faint">{fmt.usd(p.initialValue)}</td>
                    <td className="mono-num px-2 text-right text-[11px] text-text">{fmt.usd(p.currentValue)}</td>
                    <td className={cx("mono-num px-2 text-right text-[11px]", p.cashPnl >= 0 ? "text-pos" : "text-neg")}>
                      {fmt.usd(p.cashPnl, { sign: true })}
                    </td>
                    <td className="mono-num px-2 text-right text-[10px] text-faint">{p.endDate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
    </div>
  );
}
