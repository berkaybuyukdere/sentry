import { useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Eye, Copy as CopyIcon } from "lucide-react";
import { profileWallet, fmt } from "@sentry-app/polymarket";
import { usePositions, useWalletActivity, useWalletValue, useLeaderboard } from "../lib/queries";
import { useWatchPicker } from "../components/market/WatchlistPicker";
import { useCopySetup } from "../components/market/CopySetup";
import { Panel, Metric, Loading, Empty, Tag, Addr, cx } from "../components/ui/primitives";
import { PmProfileLink, AddrScanLink } from "../components/ui/ExtLink";

export function WalletIntel() {
  const { address = "" } = useParams<{ address: string }>();
  const addr = address.toLowerCase();
  const { data: positions, isLoading: posLoading } = usePositions(addr);
  const { data: activity, isLoading: actLoading } = useWalletActivity(addr, 400);
  const { data: value } = useWalletValue(addr);
  const { data: lb30 } = useLeaderboard("30d", 50);
  const openPicker = useWatchPicker((s) => s.openWallet);
  const openCopySetup = useCopySetup((s) => s.open);
  const navigate = useNavigate();

  const lbEntry = useMemo(
    () => lb30?.find((e) => e.proxyWallet.toLowerCase() === addr),
    [lb30, addr],
  );
  const alias = lbEntry?.userName || activity?.find((a) => a.name)?.name || "";

  const profile = useMemo(() => (activity ? profileWallet(activity) : null), [activity]);

  const stats = useMemo(() => {
    if (!positions) return null;
    const exposure = positions.reduce((s, p) => s + p.currentValue, 0);
    const unrealized = positions.reduce((s, p) => s + p.cashPnl, 0);
    const initial = positions.reduce((s, p) => s + p.initialValue, 0);
    const wins = positions.filter((p) => p.cashPnl > 0).length;
    const largest = [...positions].sort((a, b) => b.currentValue - a.currentValue)[0];
    return {
      exposure,
      unrealized,
      roi: initial > 0 ? unrealized / initial : 0,
      openCount: positions.length,
      winShare: positions.length ? wins / positions.length : 0,
      largest,
    };
  }, [positions]);

  const classification = useMemo(() => {
    if (!profile || !stats) return null;
    const domain = profile.domain[0]?.label?.toUpperCase() ?? "GENERAL";
    const conviction =
      stats.exposure > 100_000 ? "HIGH-CONVICTION" : stats.exposure > 10_000 ? "ACTIVE" : "LIGHT";
    return `${conviction} ${domain} TRADER`;
  }, [profile, stats]);

  return (
    <div className="flex flex-col">
      {/* dossier header */}
      <div className="hairline-b px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="label-faint">OPERATOR DOSSIER</span>
              {lbEntry && <Tag tone="accent">RANK {lbEntry.rank} · 30D COHORT</Tag>}
            </div>
            <h1 className="mt-1 flex items-baseline gap-3">
              <span className="text-[17px] font-medium text-text">{alias || "UNREGISTERED OPERATOR"}</span>
              <span className="mono-num text-[11px] text-faint">{addr}</span>
              <span className="flex items-center gap-1"><PmProfileLink address={addr} /><AddrScanLink address={addr} /></span>
            </h1>
            {classification && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="label text-accent2">CLASSIFICATION —</span>
                <span className="label">{classification}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => openCopySetup(addr, alias || fmt.shortAddr(addr))}
              className="focus-outline flex h-9 items-center gap-2 border border-accent/60 bg-accent/15 px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-accent2 transition-colors hover:bg-accent/25"
            >
              <CopyIcon size={12} strokeWidth={1.5} /> TRACK OPERATOR
            </button>
            <button
              onClick={() => openPicker(addr, alias || fmt.shortAddr(addr))}
              className="focus-outline flex h-9 items-center gap-2 border border-line-strong bg-raise2 px-3 text-[11px] uppercase tracking-[0.1em] text-dim transition-colors hover:text-text"
            >
              <Eye size={12} strokeWidth={1.5} /> WATCH
            </button>
          </div>
        </div>

        {/* headline metrics */}
        <div className="mt-4 grid grid-cols-6 gap-6">
          <Metric label="PORTFOLIO VALUE" value={value !== undefined ? fmt.usd(value) : "—"} />
          <Metric
            label="OPEN EXPOSURE"
            value={stats ? fmt.usd(stats.exposure) : "—"}
            sub={stats ? `${stats.openCount} open positions` : undefined}
          />
          <Metric
            label="UNREALIZED P&L"
            value={stats ? fmt.usd(stats.unrealized, { sign: true }) : "—"}
            tone={stats && stats.unrealized >= 0 ? "pos" : "neg"}
          />
          <Metric
            label="OPEN ROI"
            value={stats ? fmt.pct(stats.roi, 1) : "—"}
            tone={stats && stats.roi >= 0 ? "pos" : "neg"}
          />
          <Metric
            label="POSITIONS IN PROFIT"
            value={stats ? fmt.pct(stats.winShare, 0) : "—"}
          />
          <Metric
            label={`30D P&L${lbEntry ? "" : " (COHORT)"}`}
            value={lbEntry ? fmt.usd(lbEntry.pnl, { sign: true }) : "OFF-COHORT"}
            tone={lbEntry && lbEntry.pnl >= 0 ? "pos" : undefined}
            sub={lbEntry ? `vol ${fmt.usd(lbEntry.vol)}` : "not in top-50 leaderboard"}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-line p-px">
        {/* operator profile — behavioral read */}
        <Panel className="border-0" title="OPERATOR PROFILE">
          {actLoading ? (
            <Loading />
          ) : !profile || profile.activeDays === 0 ? (
            <Empty label="NO OBSERVED ACTIVITY" />
          ) : (
            <div className="flex flex-col gap-3 text-[11.5px] leading-relaxed text-dim">
              <p>
                Observed across <span className="text-text">{profile.activeDays} active days</span>
                {profile.firstSeen && (
                  <> since <span className="mono-num">{new Date(profile.firstSeen * 1000).toISOString().slice(0, 10)}</span></>
                )}
                , averaging <span className="text-text">{profile.tradesPerDay.toFixed(1)} trades/day</span>.
              </p>
              <p>
                Median clip <span className="mono-num text-text">{fmt.usd(profile.medianTradeUsd)}</span>, mean{" "}
                <span className="mono-num text-text">{fmt.usd(profile.avgTradeUsd)}</span>.{" "}
                {fmt.pct(profile.scaleInRate, 0)} of entries scale an existing position rather than open fresh risk.
              </p>
              <p>
                Direction mix: <span className="text-pos">{fmt.pct(profile.buyShare, 0)} BUY</span> /{" "}
                <span className="text-neg">{fmt.pct(1 - profile.buyShare, 0)} SELL</span>.
              </p>
              <div>
                <div className="label-faint mb-1.5">ACTIVITY BY HOUR (UTC)</div>
                <HourBars hours={profile.hourHistogram} />
              </div>
            </div>
          )}
        </Panel>

        {/* market specialization */}
        <Panel className="border-0" title="MARKET SPECIALIZATION">
          {!profile?.domain.length ? (
            <Empty label="INSUFFICIENT DATA" />
          ) : (
            <div className="flex flex-col gap-2">
              {profile.domain.map((d) => (
                <div key={d.label} className="flex items-center gap-2">
                  <span className="label w-14 shrink-0">{d.label}</span>
                  <div className="h-[5px] flex-1 bg-raise3">
                    <div className="h-full bg-accent/70" style={{ width: `${d.share * 100}%` }} />
                  </div>
                  <span className="mono-num w-10 text-right text-[11px] text-dim">{fmt.pct(d.share, 0)}</span>
                </div>
              ))}
              <div className="label-faint mt-2">SHARE OF OBSERVED NOTIONAL</div>
            </div>
          )}
        </Panel>

        {/* largest position */}
        <Panel className="border-0" title="CONCENTRATION">
          {stats?.largest ? (
            <button
              onClick={() => navigate(`/market/${stats.largest.slug}`)}
              className="w-full text-left"
            >
              <div className="label-faint">LARGEST OPEN POSITION</div>
              <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-text hover:text-accent2">
                {stats.largest.title}
              </div>
              <div className="mono-num mt-2 grid grid-cols-2 gap-y-1 text-[11px] text-dim">
                <span>SIDE — {stats.largest.outcome.toUpperCase()}</span>
                <span className="text-right">{fmt.usd(stats.largest.currentValue)}</span>
                <span>ENTRY {(stats.largest.avgPrice * 100).toFixed(1)}¢ → {(stats.largest.curPrice * 100).toFixed(1)}¢</span>
                <span className={cx("text-right", stats.largest.cashPnl >= 0 ? "text-pos" : "text-neg")}>
                  {fmt.usd(stats.largest.cashPnl, { sign: true })}
                </span>
              </div>
              <div className="mt-2 h-[3px] bg-raise3">
                <div
                  className="h-full bg-warn/70"
                  style={{ width: `${Math.min(100, (stats.largest.currentValue / Math.max(stats.exposure, 1)) * 100)}%` }}
                />
              </div>
              <div className="label-faint mt-1">
                {fmt.pct(stats.largest.currentValue / Math.max(stats.exposure, 1), 0)} OF OPEN EXPOSURE
              </div>
            </button>
          ) : (
            <Empty label="NO OPEN POSITIONS" />
          )}
        </Panel>

        {/* active positions */}
        <Panel className="col-span-2 border-0" title="ACTIVE POSITIONS" pad={false}>
          {posLoading ? (
            <Loading />
          ) : !positions?.length ? (
            <Empty label="NO OPEN POSITIONS" />
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-raise">
                  <tr className="hairline-b">
                    <th className="label-faint px-3 py-1.5 text-left font-medium">MARKET</th>
                    <th className="label-faint px-2 py-1.5 text-left font-medium">SIDE</th>
                    <th className="label-faint px-2 py-1.5 text-right font-medium">ENTRY → NOW</th>
                    <th className="label-faint px-2 py-1.5 text-right font-medium">VALUE</th>
                    <th className="label-faint px-2 py-1.5 text-right font-medium">P&L</th>
                    <th className="label-faint px-2 py-1.5 text-right font-medium">P&L %</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.slice(0, 60).map((p) => (
                    <tr
                      key={p.asset}
                      onClick={() => navigate(`/market/${p.slug}`)}
                      className="hairline-b h-9 cursor-pointer row-hover"
                    >
                      <td className="max-w-0 truncate px-3 text-[11.5px] text-text">{p.title}</td>
                      <td className="px-2">
                        <span className={cx("text-[10px] font-semibold tracking-[0.08em]", p.outcomeIndex === 0 ? "text-pos" : "text-neg")}>
                          {p.outcome.toUpperCase()}
                        </span>
                      </td>
                      <td className="mono-num px-2 text-right text-[10.5px] text-dim">
                        {(p.avgPrice * 100).toFixed(1)}¢ → {(p.curPrice * 100).toFixed(1)}¢
                      </td>
                      <td className="mono-num px-2 text-right text-[11px] text-text">{fmt.usd(p.currentValue)}</td>
                      <td className={cx("mono-num px-2 text-right text-[11px]", p.cashPnl >= 0 ? "text-pos" : "text-neg")}>
                        {fmt.usd(p.cashPnl, { sign: true })}
                      </td>
                      <td className={cx("mono-num px-2 text-right text-[10.5px]", p.percentPnl >= 0 ? "text-pos" : "text-neg")}>
                        {p.percentPnl >= 0 ? "+" : ""}{p.percentPnl.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* trade history */}
        <Panel className="border-0" title="EXECUTION HISTORY" pad={false}>
          {actLoading ? (
            <Loading />
          ) : !activity?.length ? (
            <Empty label="NO ACTIVITY ON RECORD" />
          ) : (
            <div className="flex max-h-[420px] flex-col overflow-y-auto">
              {activity
                .filter((a) => a.type === "TRADE")
                .slice(0, 60)
                .map((a) => (
                  <Link
                    key={`${a.transactionHash}${a.asset}${a.timestamp}`}
                    to={`/market/${a.slug}`}
                    className="hairline-b row-hover flex items-center gap-2 px-3 py-[7px]"
                  >
                    <span className={cx("w-7 shrink-0 text-[9px] font-semibold", a.side === "BUY" ? "text-pos" : "text-neg")}>
                      {a.side}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-dim">{a.title}</span>
                    <span className="mono-num shrink-0 text-[10px] text-faint">{(a.price * 100).toFixed(1)}¢</span>
                    <span className="mono-num w-[52px] shrink-0 text-right text-[10.5px] text-text">
                      {fmt.usd(a.usdcSize)}
                    </span>
                    <span className="mono-num w-8 shrink-0 text-right text-[9px] text-faint">{fmt.timeAgo(a.timestamp)}</span>
                  </Link>
                ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function HourBars({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 1);
  return (
    <div className="flex h-10 items-end gap-px">
      {hours.map((h, i) => (
        <div key={i} className="flex-1 bg-raise3" style={{ height: "100%", position: "relative" }} title={`${String(i).padStart(2, "0")}:00 UTC — ${h} trades`}>
          <div
            className="absolute bottom-0 left-0 right-0 bg-accent/60"
            style={{ height: `${(h / max) * 100}%` }}
          />
        </div>
      ))}
    </div>
  );
}
