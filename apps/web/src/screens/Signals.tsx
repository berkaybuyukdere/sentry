import { useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { severityRank, fmt, type SignalType } from "@sentry-app/polymarket";
import { useSignals } from "../lib/signals";
import { useMarkets } from "../lib/queries";
import { useTicket } from "../components/market/ticket";
import { useBilling, bpsPct, tierById } from "../lib/billing";
import { Tag, Empty, severityTone, cx, Btn } from "../components/ui/primitives";

const TYPES: { key: SignalType | "ALL"; label: string }[] = [
  { key: "ALL", label: "ALL" },
  { key: "SMART_WALLET_CLUSTER", label: "SMART CLUSTER" },
  { key: "CLUSTER_ENTRY", label: "CLUSTER" },
  { key: "WHALE_ENTRY", label: "WHALE" },
  { key: "SMART_WALLET_ENTRY", label: "SMART WALLET" },
  { key: "PROBABILITY_ACCELERATION", label: "ACCELERATION" },
  { key: "VOLUME_ANOMALY", label: "VOLUME ANOMALY" },
  { key: "TAPE_MOMENTUM", label: "MOMENTUM" },
];

export function SignalsScreen() {
  const signals = useSignals((s) => s.signals);
  const [type, setType] = useState<SignalType | "ALL">("ALL");
  const [minSeverity, setMinSeverity] = useState(0);
  const navigate = useNavigate();
  const { data: markets } = useMarkets({ limit: 400 }, 60_000);
  const stage = useTicket((s) => s.stage);
  const signalRate = tierById(useBilling((s) => s.tier)).rates.SIGNAL;

  const executeSignal = (s: (typeof signals)[number]) => {
    const market = markets?.find((m) => m.conditionId === s.conditionId || m.slug === s.marketSlug);
    if (!market) {
      if (s.marketSlug) navigate(`/market/${s.marketSlug}`);
      return;
    }
    const outcomeIdx = s.outcome ? Math.max(0, market.outcomes.findIndex((o) => o === s.outcome)) : 0;
    stage(market, outcomeIdx, s.side ?? "BUY", undefined, "SIGNAL");
  };

  const rows = useMemo(
    () =>
      signals.filter(
        (s) => (type === "ALL" || s.type === type) && severityRank(s.severity) >= minSeverity,
      ),
    [signals, type, minSeverity],
  );

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">SIGNAL ENGINE</h1>
        <span className="mono-num text-[10px] text-faint">{rows.length} ACTIVE</span>
        <div className="flex-1" />
        <div className="flex gap-px bg-line">
          {(["LOW", "ELEVATED", "HIGH", "CRITICAL"] as const).map((s, i) => (
            <button
              key={s}
              onClick={() => setMinSeverity(i)}
              className={cx(
                "focus-outline h-7 px-2.5 text-[9px] font-medium tracking-[0.1em] transition-colors",
                minSeverity === i ? "bg-raise3 text-text" : "bg-raise text-faint hover:text-dim",
              )}
            >
              ≥ {s}
            </button>
          ))}
        </div>
      </div>

      <div className="hairline-b flex flex-wrap gap-px bg-line px-px py-px">
        {TYPES.map((t) => (
          <button
            key={t.key}
            onClick={() => setType(t.key)}
            className={cx(
              "focus-outline h-6 px-2.5 text-[9px] font-medium tracking-[0.1em] transition-colors",
              type === t.key ? "bg-raise3 text-accent2" : "bg-raise text-faint hover:text-dim",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!rows.length ? (
        <Empty
          label="NO SIGNALS AT THIS THRESHOLD"
          hint="The engine scans the live tape and market snapshots continuously."
        />
      ) : (
        <div className="flex flex-col">
          {rows.slice(0, 80).map((s) => (
            <div key={s.id} className="hairline-b px-4 py-3 row-hover">
              <div className="flex items-center gap-2.5">
                <span className="mono-num text-[10px] text-faint">SIGNAL {s.id}</span>
                <Tag tone={severityTone(s.severity)}>{s.type.replaceAll("_", " ")}</Tag>
                <Tag tone={severityTone(s.severity)}>{s.severity}</Tag>
                <span className="mono-num ml-auto text-[10px] text-faint">
                  {fmt.utcClock(s.ts)} UTC · {fmt.timeAgo(s.ts)} AGO
                </span>
              </div>
              {s.marketTitle && (
                <Link
                  to={s.marketSlug ? `/market/${s.marketSlug}` : "#"}
                  className="mt-1.5 block text-[13px] text-text hover:text-accent2"
                >
                  {s.marketTitle}
                </Link>
              )}
              <div className="mt-1 text-[11.5px] leading-relaxed text-dim">
                {s.title}. {s.detail}
              </div>
              <div className="mt-2 flex items-center gap-4">
                {s.usd > 0 && (
                  <span className="mono-num text-[10.5px] text-accent2">
                    EXPOSURE {fmt.usd(s.usd)}
                  </span>
                )}
                <span className="mono-num text-[10.5px] text-faint">
                  CONFIDENCE {(s.confidence * 10).toFixed(1)}/10
                </span>
                {s.wallets.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    {s.wallets.slice(0, 4).map((w) => (
                      <Link key={w} to={`/wallet/${w.toLowerCase()}`} className="mono-num text-[10px] text-dim hover:text-accent2">
                        {fmt.shortAddr(w)}
                      </Link>
                    ))}
                    {s.wallets.length > 4 && (
                      <span className="mono-num text-[10px] text-faint">+{s.wallets.length - 4}</span>
                    )}
                  </span>
                )}
                <span className="ml-auto flex gap-1.5">
                  {s.marketSlug && (
                    <>
                      <Btn size="sm" variant="yes" onClick={() => executeSignal(s)} title={`Intelligence execution rate ${bpsPct(signalRate)}`}>
                        EXECUTE SIGNAL · {bpsPct(signalRate)}
                      </Btn>
                      <Btn size="sm" onClick={() => navigate(`/market/${s.marketSlug}`)}>
                        OPEN MARKET
                      </Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          navigate(`/rules?market=${s.marketSlug}&title=${encodeURIComponent(s.marketTitle ?? "")}`)
                        }
                      >
                        CREATE ALERT
                      </Btn>
                    </>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
