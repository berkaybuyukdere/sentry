import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fmt, type LeaderboardWindow } from "@sentry-app/polymarket";
import { useLeaderboard } from "../lib/queries";
import { Loading, Tag, cx } from "../components/ui/primitives";
import { PmProfileLink } from "../components/ui/ExtLink";
import { useCopySetup } from "../components/market/CopySetup";
import { operatorRewardTier, useBilling, bpsPct, tierById } from "../lib/billing";

const WINDOWS: { key: LeaderboardWindow; label: string }[] = [
  { key: "1d", label: "TODAY" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "all", label: "ALL TIME" },
];

export function Operators() {
  const [win, setWin] = useState<LeaderboardWindow>("1d");
  const { data, isLoading } = useLeaderboard(win, 50);
  const navigate = useNavigate();
  const openCopySetup = useCopySetup((s) => s.open);
  const billingTier = useBilling((s) => s.tier);
  const copyRate = tierById(billingTier).rates.COPY;

  const rows = useMemo(() => {
    if (!data) return [];
    return data.map((e) => ({
      ...e,
      roi: e.vol > 0 ? e.pnl / e.vol : 0,
      efficiency: e.vol > 0 ? Math.min(Math.abs(e.pnl) / e.vol, 1) : 0,
    }));
  }, [data]);

  const maxPnl = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">OPERATOR RANKINGS — COPY MARKETPLACE</h1>
        <span className="mono-num text-[10px] text-faint">EXECUTION RATE FROM {bpsPct(copyRate)} · PROFITABILITY COHORT</span>
        <div className="flex-1" />
        <div className="flex gap-px bg-line">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className={cx(
                "focus-outline h-7 px-3 text-[10px] font-medium tracking-[0.12em] transition-colors",
                win === w.key ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Loading label="RESOLVING COHORT" className="h-40" />
      ) : (
        <div className="grid grid-cols-2 gap-px bg-line p-px">
          {rows.map((r) => {
            const rank = Number(r.rank);
            const rewardTier = operatorRewardTier(rank);
            return (
              <button
                key={r.proxyWallet}
                onClick={() => navigate(`/wallet/${r.proxyWallet.toLowerCase()}`)}
                className="group bg-raise px-4 py-3 text-left transition-colors hover:bg-raise2"
              >
                <div className="flex items-center gap-3">
                  <span className="mono-num w-8 text-[15px] text-faint group-hover:text-dim">
                    {String(rank).padStart(2, "0")}
                  </span>
                  {r.profileImage ? (
                    <img src={r.profileImage} alt="" className="size-6 shrink-0 border border-line object-cover" />
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center border border-line bg-raise3 text-[9px] text-accent2">
                      {(r.userName || r.proxyWallet.slice(2, 4)).slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-medium text-text">
                        {r.userName || "UNREGISTERED"}
                      </span>
                      <Tag tone={rewardTier === "ELITE" ? "warn" : rewardTier === "TIER-1" ? "accent" : "dim"}>
                        {rewardTier} OPERATOR
                      </Tag>
                      {r.verifiedBadge && <Tag tone="pos">VERIFIED</Tag>}
                    </div>
                    <div className="mono-num mt-0.5 flex items-center gap-2 text-[10px] text-faint">
                      <span className="truncate">{r.proxyWallet}</span>
                      <PmProfileLink address={r.proxyWallet} label="PM" />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-end gap-6">
                    <div className="text-right">
                      <div className="label-faint">P&L {WINDOWS.find((w) => w.key === win)?.label}</div>
                      <div className={cx("mono-num text-[15px]", r.pnl >= 0 ? "text-pos" : "text-neg")}>
                        {fmt.usd(r.pnl, { sign: true })}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="label-faint">VOLUME</div>
                      <div className="mono-num text-[13px] text-dim">{fmt.usd(r.vol)}</div>
                    </div>
                    <div className="text-right">
                      <div className="label-faint">P&L / VOL</div>
                      <div className="mono-num text-[13px] text-dim">{fmt.pct(r.roi, 1)}</div>
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-[3px] flex-1 bg-raise3">
                    <div
                      className={cx("h-full", r.pnl >= 0 ? "bg-pos/60" : "bg-neg/60")}
                      style={{ width: `${(Math.abs(r.pnl) / maxPnl) * 100}%` }}
                    />
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      openCopySetup(r.proxyWallet, r.userName || r.proxyWallet.slice(0, 8));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && openCopySetup(r.proxyWallet, r.userName || r.proxyWallet.slice(0, 8))}
                    className="focus-outline flex h-[22px] shrink-0 items-center border border-accent/60 bg-accent/10 px-2 text-[9px] font-medium uppercase tracking-[0.12em] text-accent2 transition-colors hover:bg-accent/20"
                  >
                    COPY OPERATOR
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
