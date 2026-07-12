import { Check } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { TIERS, useBilling, bpsPct, OPERATOR_REWARD_BPS, type TierId } from "../lib/billing";
import { Panel, Btn, Tag, cx } from "../components/ui/primitives";

/** ACCESS TIERS — subscription + execution economics.
 *  Every rate is printed. No hidden fees, no performance cut, no gamification. */
export function Pricing() {
  const current = useBilling((s) => s.tier);
  const setTier = useBilling((s) => s.setTier);
  const ledger = useBilling((s) => s.ledger);

  const paid30d = ledger
    .filter((l) => l.ts > Date.now() - 30 * 86400_000)
    .reduce((s, l) => s + l.feeUsd, 0);

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">ACCESS TIERS</h1>
        <span className="label-faint">WE EARN WHEN WE EXECUTE — NEVER FROM YOUR P&L</span>
        <div className="flex-1" />
        <span className="mono-num text-[10px] text-faint">
          YOUR 30D EXECUTION FEES — {fmt.usd(paid30d, { compact: false })}
        </span>
      </div>

      {/* tier grid */}
      <div className="grid grid-cols-4 gap-px bg-line p-px">
        {TIERS.map((t) => {
          const active = t.id === current;
          return (
            <div key={t.id} className={cx("flex flex-col bg-raise", active && "outline outline-1 -outline-offset-1 outline-accent")}>
              <div className="hairline-b px-4 pb-3 pt-4">
                <div className="flex items-center justify-between">
                  <span className={cx("text-[13px] font-semibold tracking-[0.2em]", t.id === "BLACK" ? "text-text" : "text-dim")}>
                    {t.name}
                  </span>
                  {active && <Tag tone="accent">CURRENT</Tag>}
                </div>
                <div className="mono-num mt-2 text-[22px] leading-none text-text">
                  ${t.monthlyUsd}
                  <span className="text-[10px] text-faint"> / MONTH</span>
                </div>
              </div>

              <div className="hairline-b px-4 py-3">
                {(
                  [
                    ["MANUAL EXECUTION", t.rates.MANUAL],
                    ["SIGNAL EXECUTION", t.rates.SIGNAL],
                    ["COPY EXECUTION", t.rates.COPY],
                  ] as const
                ).map(([label, bps]) => (
                  <div key={label} className="flex items-center justify-between py-0.5">
                    <span className="label-faint">{label}</span>
                    <span className="mono-num text-[11.5px] text-accent2">{bpsPct(bps)}</span>
                  </div>
                ))}
              </div>

              <div className="flex-1 px-4 py-3">
                {t.entitlements.features.map((f) => (
                  <div key={f} className="flex items-center gap-2 py-[3px]">
                    <Check size={10} strokeWidth={1.5} className="shrink-0 text-pos" />
                    <span className="text-[10.5px] text-dim">{f}</span>
                  </div>
                ))}
              </div>

              <div className="px-4 pb-4">
                <Btn
                  variant={active ? "default" : t.id === "BLACK" ? "default" : "accent"}
                  size="lg"
                  className="w-full"
                  disabled={active}
                  onClick={() => setTier(t.id as TierId)}
                >
                  {active ? "ACTIVE" : t.monthlyUsd === 0 ? "DOWNGRADE" : `ACTIVATE ${t.name}`}
                </Btn>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-px bg-line p-px">
        {/* fee doctrine */}
        <Panel className="border-0" title="FEE DOCTRINE">
          <div className="flex flex-col gap-2 text-[11px] leading-relaxed text-dim">
            <p>
              <span className="text-text">Execution-only pricing.</span> Fees apply to successfully
              executed notional. Unfilled orders, unexecuted signals and idle tracking accrue
              nothing.
            </p>
            <p>
              <span className="text-text">No performance cut.</span> SENTRY is never a partner in
              your P&L — win or lose, the rate is the rate.
            </p>
            <p>
              <span className="text-text">Inside the protocol ceiling.</span> All taker execution
              rates sit under Polymarket's Builder Program maximum (1.00%), and builder fees are
              publicly queryable — nothing is hidden.
            </p>
            <p className="text-faint">
              Discipline note: SENTRY carries no streaks, no badges-for-volume, no casino
              mechanics. Risk limits and execution quality are surfaced ahead of activity.
            </p>
          </div>
        </Panel>

        {/* operator economy */}
        <Panel className="border-0" title="OPERATOR ECONOMY — COPY REWARDS" pad={false}>
          <div className="px-4 py-3">
            <p className="text-[11px] leading-relaxed text-dim">
              When your strategy is copied, a share of copy-execution notional routes to you.
              Rank up the cohort, earn a larger share — the flywheel funds the operators worth
              following.
            </p>
          </div>
          <div className="hairline-t">
            {(Object.entries(OPERATOR_REWARD_BPS) as [string, number][]).map(([tier, bps]) => (
              <div key={tier} className="hairline-b flex items-center justify-between px-4 py-2">
                <div className="flex items-center gap-2">
                  <Tag tone={tier === "ELITE" ? "warn" : tier === "TIER-1" ? "accent" : "dim"}>{tier}</Tag>
                  <span className="label-faint">
                    {tier === "STANDARD" ? "COHORT MEMBER" : tier === "VERIFIED" ? "TOP 50%" : tier === "TIER-1" ? "TOP 10%" : "SELECTED"}
                  </span>
                </div>
                <span className="mono-num text-[11.5px] text-pos">{bpsPct(bps)} OF COPIED NOTIONAL</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* billing status */}
        <Panel className="border-0" title="BILLING RAILS — STATUS">
          <div className="flex flex-col gap-2 text-[11px] leading-relaxed text-dim">
            <div className="flex items-center gap-2">
              <Tag tone="pos">LIVE</Tag>
              <span>Tier switching, fee schedule, execution-fee accrual ledger</span>
            </div>
            <div className="flex items-center gap-2">
              <Tag tone="warn">PENDING</Tag>
              <span>On-chain builder-fee collection — activates with Builder Program registration</span>
            </div>
            <div className="flex items-center gap-2">
              <Tag tone="warn">PENDING</Tag>
              <span>Card subscription billing — activates with the app backend</span>
            </div>
            <p className="mt-1 text-faint">
              Until rails connect, tiers are switchable for full product validation and the
              ledger records what each execution would have accrued.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
