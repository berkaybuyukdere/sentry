import { useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Pause, Play, Trash2, Crosshair } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { useCopy } from "../lib/copy";
import { useMarkets, useLeaderboard } from "../lib/queries";
import { useBilling, bpsPct, canActivateCopyStrategy, tierById } from "../lib/billing";
import { useTicket } from "../components/market/ticket";
import { Panel, Metric, Btn, Tag, Empty, cx } from "../components/ui/primitives";

export function CopyEngine() {
  const { strategies, signals, update, remove, setSignalStatus } = useCopy();
  const { data: markets } = useMarkets({ limit: 400 }, 60_000);
  const { data: lb30 } = useLeaderboard("30d", 50);
  const tier = useBilling((s) => s.tier);
  const copyRate = tierById(tier).rates.COPY;
  const stage = useTicket((s) => s.stage);
  const navigate = useNavigate();

  const pending = signals.filter((s) => s.status === "PENDING");
  const executed = signals.filter((s) => s.status === "EXECUTED");

  const stats = useMemo(
    () => ({
      active: strategies.filter((s) => s.active).length,
      tracked: new Set(strategies.map((s) => s.wallet)).size,
      generated: strategies.reduce((n, s) => n + s.signalsGenerated, 0),
    }),
    [strategies],
  );

  const mirror = (sig: (typeof signals)[number]) => {
    const market = markets?.find((m) => m.conditionId === sig.conditionId || m.slug === sig.marketSlug);
    if (market) {
      const entry = lb30?.find((e) => e.proxyWallet.toLowerCase() === sig.wallet);
      stage(
        market,
        Math.max(0, market.outcomes.findIndex((o) => o === sig.outcome)),
        sig.side,
        sig.suggestedUsd,
        "COPY",
        { wallet: sig.wallet, alias: sig.alias, rank: entry ? Number(entry.rank) : null },
      );
      setSignalStatus(sig.id, "EXECUTED");
    } else {
      navigate(`/market/${sig.marketSlug}`);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="hairline-b px-4 py-3">
        <div className="mb-3 flex items-baseline justify-between">
          <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">COPY ENGINE</h1>
          <span className="label-faint">EXECUTION RATE {bpsPct(copyRate)} · APPLIED ONLY TO SUCCESSFULLY MIRRORED EXECUTION</span>
        </div>
        <div className="grid grid-cols-5 gap-6">
          <Metric label="ACTIVE STRATEGIES" value={stats.active} tone={stats.active ? "accent" : undefined} />
          <Metric label="TRACKED OPERATORS" value={stats.tracked} />
          <Metric label="SIGNALS GENERATED" value={stats.generated} />
          <Metric label="PENDING REVIEW" value={pending.length} tone={pending.length ? "warn" : undefined} />
          <Metric label="EXECUTED MIRRORS" value={executed.length} tone={executed.length ? "pos" : undefined} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-line p-px">
        {/* strategies */}
        <Panel className="border-0" title="STRATEGIES" pad={false}>
          {!strategies.length ? (
            <Empty
              label="NO STRATEGIES CONFIGURED"
              hint="Open an operator dossier and select TRACK OPERATOR."
            />
          ) : (
            <div className="flex flex-col">
              {strategies.map((s) => (
                <div key={s.id} className="hairline-b px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="mono-num text-[9px] text-faint">{s.id}</span>
                    <Link to={`/wallet/${s.wallet}`} className="text-[12px] text-text hover:text-accent2">
                      {s.alias}
                    </Link>
                    <Tag tone={s.active ? "pos" : "dim"}>{s.active ? "ACTIVE" : "PAUSED"}</Tag>
                    <div className="flex-1" />
                    <Btn
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (!s.active && !canActivateCopyStrategy(strategies.filter((x) => x.active).length)) {
                          navigate("/pricing");
                          return;
                        }
                        update(s.id, { active: !s.active });
                      }}
                    >
                      {s.active ? <Pause size={10} strokeWidth={1.5} /> : <Play size={10} strokeWidth={1.5} />}
                      {s.active ? "PAUSE" : "RESUME"}
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => remove(s.id)}>
                      <Trash2 size={10} strokeWidth={1.5} /> TERMINATE
                    </Btn>
                  </div>
                  <div className="mono-num mt-1.5 flex gap-4 text-[9.5px] uppercase tracking-[0.06em] text-faint">
                    <span>
                      SIZE — {s.sizingMode === "FIXED" ? fmt.usd(s.fixedUsd) : `${s.proportionPct}% OF SOURCE`}
                    </span>
                    <span>CAP {fmt.usd(s.maxPositionUsd)}</span>
                    <span>MIN SRC {fmt.usd(s.minSourceUsd)}</span>
                    <span>SIDE {s.side}</span>
                    <span>{s.signalsGenerated} SIGNALS</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* copy signals */}
        <Panel className="border-0" title="COPY SIGNALS — REVIEW QUEUE" pad={false}>
          {!signals.length ? (
            <Empty label="QUEUE EMPTY" hint="Signals appear when tracked operators trade." />
          ) : (
            <div className="flex max-h-[560px] flex-col overflow-y-auto">
              {signals.slice(0, 40).map((sig) => (
                <div
                  key={sig.id}
                  className={cx("hairline-b px-3 py-2.5", sig.status === "PENDING" && "bg-accent/[0.03]")}
                >
                  <div className="flex items-center gap-2">
                    <Tag
                      tone={
                        sig.status === "PENDING" ? "warn" : sig.status === "EXECUTED" ? "pos" : "dim"
                      }
                    >
                      {sig.status}
                    </Tag>
                    <span className="text-[11px] text-dim">{sig.alias}</span>
                    <span className={cx("text-[10px] font-semibold", sig.side === "BUY" ? "text-pos" : "text-neg")}>
                      {sig.side} {sig.outcome.toUpperCase()}
                    </span>
                    <span className="mono-num ml-auto text-[9px] text-faint">{fmt.timeAgo(sig.ts)} AGO</span>
                  </div>
                  <Link
                    to={`/market/${sig.marketSlug}`}
                    className="mt-1 line-clamp-1 block text-[11.5px] text-text hover:text-accent2"
                  >
                    {sig.marketTitle}
                  </Link>
                  <div className="mono-num mt-1 flex items-center gap-3 text-[10px] text-faint">
                    <span>SRC {fmt.usd(sig.sourceUsd)} @ {(sig.price * 100).toFixed(1)}¢</span>
                    <span className="text-accent2">SUGGESTED {fmt.usd(sig.suggestedUsd)}</span>
                    {sig.status === "PENDING" && (
                      <span className="ml-auto flex gap-1">
                        <Btn size="sm" variant="yes" onClick={() => mirror(sig)}>
                          <Crosshair size={10} strokeWidth={1.5} /> MIRROR
                        </Btn>
                        <Btn size="sm" variant="ghost" onClick={() => setSignalStatus(sig.id, "DISMISSED")}>
                          DISMISS
                        </Btn>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
