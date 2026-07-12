import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { useRules, useNotifications, type RuleMetric, type RuleOp } from "../lib/alerts";
import { Panel, Btn, Tag, Empty, cx } from "../components/ui/primitives";

const METRICS: { key: RuleMetric; label: string; unit: string; defaultOp: RuleOp; global: boolean }[] = [
  { key: "PROBABILITY", label: "MARKET PROBABILITY", unit: "%", defaultOp: "ABOVE", global: false },
  { key: "DELTA_1H", label: "|Δ PROBABILITY| 1H", unit: "pp", defaultOp: "ABOVE", global: true },
  { key: "DELTA_24H", label: "|Δ PROBABILITY| 24H", unit: "pp", defaultOp: "ABOVE", global: true },
  { key: "VOLUME_24H", label: "24H VOLUME", unit: "USD", defaultOp: "ABOVE", global: true },
  { key: "WHALE_TRADE_USD", label: "SINGLE FILL NOTIONAL", unit: "USD", defaultOp: "ABOVE", global: true },
  { key: "SMART_CLUSTER", label: "CLUSTER WALLET COUNT", unit: "wallets", defaultOp: "ABOVE", global: true },
];

/** Monitoring rule builder — WHEN <metric> <op> <value> [in market] THEN alert. */
export function RulesScreen() {
  const [params] = useSearchParams();
  const { rules, add, toggle, remove } = useRules();
  const notify = useNotifications((s) => s.push);

  const [metric, setMetric] = useState<RuleMetric>("PROBABILITY");
  const [op, setOp] = useState<RuleOp>("ABOVE");
  const [value, setValue] = useState(60);
  const [marketSlug, setMarketSlug] = useState(params.get("market") ?? "");
  const [marketTitle, setMarketTitle] = useState(params.get("title") ?? "");

  const spec = METRICS.find((m) => m.key === metric)!;

  const create = () => {
    add({
      name: `${spec.label} ${op} ${value}${spec.unit === "%" ? "%" : ` ${spec.unit}`}`,
      metric,
      op,
      value,
      marketSlug: marketSlug.trim() || null,
      marketTitle: marketTitle.trim() || null,
      active: true,
    });
    notify({
      kind: "RULE",
      title: "MONITORING RULE ACTIVE",
      body: `${spec.label} ${op} ${value} — ${marketTitle || "GLOBAL SCOPE"}`,
      href: "/rules",
    });
  };

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">MONITORING RULES</h1>
        <span className="mono-num text-[10px] text-faint">
          {rules.filter((r) => r.active).length} ACTIVE · EVALUATED ≤45S
        </span>
      </div>

      <div className="grid grid-cols-5 gap-px bg-line p-px">
        {/* builder */}
        <Panel className="col-span-2 border-0" title="RULE COMPOSER">
          <div className="flex flex-col gap-4">
            <div>
              <div className="label mb-1.5 text-accent2">WHEN</div>
              <div className="flex flex-col gap-px bg-line">
                {METRICS.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => {
                      setMetric(m.key);
                      setOp(m.defaultOp);
                    }}
                    className={cx(
                      "focus-outline flex h-7 items-center justify-between px-2.5 text-[10.5px] tracking-[0.04em] transition-colors",
                      metric === m.key ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                    )}
                  >
                    {m.label}
                    <span className="label-faint">{m.unit}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5 text-accent2">IS</div>
                <div className="flex gap-px bg-line">
                  {(["ABOVE", "BELOW"] as const).map((o) => (
                    <button
                      key={o}
                      onClick={() => setOp(o)}
                      disabled={metric !== "PROBABILITY" && metric !== "VOLUME_24H" && o === "BELOW"}
                      className={cx(
                        "focus-outline h-7 flex-1 text-[10px] font-medium tracking-[0.12em] transition-colors disabled:opacity-30",
                        op === o ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                      )}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="label mb-1.5 text-accent2">THRESHOLD ({spec.unit})</div>
                <input
                  type="number"
                  value={value}
                  onChange={(e) => setValue(Number(e.target.value))}
                  className="focus-outline mono-num h-7 w-full border border-line bg-raise2 px-2 text-[12px] text-text"
                />
              </div>
            </div>

            <div>
              <div className="label mb-1.5 text-accent2">SCOPE</div>
              <input
                value={marketTitle}
                onChange={(e) => setMarketTitle(e.target.value)}
                placeholder="GLOBAL — ANY TRACKED MARKET"
                readOnly={!!params.get("market") && marketSlug === params.get("market")}
                className="focus-outline h-7 w-full border border-line bg-raise2 px-2 text-[11px] text-text placeholder:text-faint"
              />
              {marketSlug && (
                <div className="mt-1 flex items-center justify-between">
                  <span className="mono-num text-[9px] text-faint">{marketSlug}</span>
                  <button
                    onClick={() => {
                      setMarketSlug("");
                      setMarketTitle("");
                    }}
                    className="label-faint hover:text-dim"
                  >
                    CLEAR → GLOBAL
                  </button>
                </div>
              )}
            </div>

            <div className="border border-line bg-raise2 px-3 py-2">
              <div className="label-faint">COMPILED RULE</div>
              <div className="mono-num mt-1 text-[11px] leading-relaxed text-dim">
                WHEN <span className="text-text">{spec.label}</span> IS{" "}
                <span className="text-text">{op}</span> <span className="text-accent2">{value}{spec.unit === "%" ? "%" : ""}</span>
                <br />
                SCOPE <span className="text-text">{marketTitle ? marketTitle.slice(0, 40) : "GLOBAL"}</span>
                <br />
                THEN <span className="text-warn">CREATE PRIORITY ALERT</span>
              </div>
            </div>

            <Btn variant="accent" size="lg" onClick={create}>
              ACTIVATE MONITORING RULE
            </Btn>
          </div>
        </Panel>

        {/* active rules */}
        <Panel className="col-span-3 border-0" title="RULE REGISTRY" pad={false}>
          {!rules.length ? (
            <Empty label="NO RULES DEFINED" hint="Compose a rule to begin automated monitoring." />
          ) : (
            <div className="flex flex-col">
              {rules.map((r) => (
                <div key={r.id} className="hairline-b flex items-center gap-3 px-4 py-2.5">
                  <span className="mono-num text-[10px] text-faint">{r.id}</span>
                  <Tag tone={r.active ? "pos" : "dim"}>{r.active ? "ARMED" : "DISARMED"}</Tag>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] text-text">{r.name}</div>
                    <div className="label-faint mt-0.5">
                      {r.marketTitle ? r.marketTitle.slice(0, 60) : "GLOBAL SCOPE"} ·{" "}
                      {r.fireCount > 0 ? `FIRED ${r.fireCount}×` : "NEVER FIRED"}
                    </div>
                  </div>
                  <Btn size="sm" variant="ghost" onClick={() => toggle(r.id)}>
                    {r.active ? "DISARM" : "ARM"}
                  </Btn>
                  <Btn size="sm" variant="danger" onClick={() => remove(r.id)}>
                    <Trash2 size={10} strokeWidth={1.5} />
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
