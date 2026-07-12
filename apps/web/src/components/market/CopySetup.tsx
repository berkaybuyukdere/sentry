import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { create } from "zustand";
import { useNavigate } from "react-router-dom";
import { useCopy } from "../../lib/copy";
import { useNotifications } from "../../lib/alerts";
import { useBilling, bpsPct, canActivateCopyStrategy, tierById } from "../../lib/billing";
import { Btn, Tag, cx } from "../ui/primitives";

interface CopySetupState {
  wallet: string | null;
  alias: string;
  open: (wallet: string, alias: string) => void;
  close: () => void;
}

export const useCopySetup = create<CopySetupState>((set) => ({
  wallet: null,
  alias: "",
  open: (wallet, alias) => set({ wallet: wallet.toLowerCase(), alias }),
  close: () => set({ wallet: null, alias: "" }),
}));

/** COPY STRATEGY configuration — manual-signal mode, fully user-controlled. */
export function CopySetup() {
  const { wallet, alias, close } = useCopySetup();
  const add = useCopy((s) => s.add);
  const strategies = useCopy((s) => s.strategies);
  const notify = useNotifications((s) => s.push);
  const navigate = useNavigate();
  const tier = useBilling((s) => s.tier);
  const copyRate = tierById(tier).rates.COPY;
  const allowActivate = canActivateCopyStrategy(strategies.filter((x) => x.active).length);

  const [sizingMode, setSizingMode] = useState<"FIXED" | "PROPORTIONAL">("FIXED");
  const [fixedUsd, setFixedUsd] = useState(100);
  const [proportionPct, setProportionPct] = useState(5);
  const [maxPositionUsd, setMaxPositionUsd] = useState(500);
  const [minSourceUsd, setMinSourceUsd] = useState(1000);
  const [side, setSide] = useState<"BUY" | "SELL" | "BOTH">("BUY");

  if (!wallet) return null;

  const activate = () => {
    add({
      wallet,
      alias: alias || wallet,
      active: true,
      sizingMode,
      fixedUsd,
      proportionPct,
      maxPositionUsd,
      minSourceUsd,
      side,
    });
    notify({
      kind: "COPY",
      title: "STRATEGY ACTIVE",
      body: `Tracking ${alias || wallet} — signals will surface when the operator trades.`,
      href: "/copy",
    });
    close();
  };

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="label-faint mb-1">{label}</div>
      {children}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={close}>
      <div className="panel w-[420px] border-line-strong" onClick={(e) => e.stopPropagation()}>
        <header className="hairline-b flex h-9 items-center justify-between px-3">
          <span className="label">COPY STRATEGY — CONFIGURATION</span>
          <button onClick={close} className="focus-outline text-faint hover:text-text">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-4">
          <div className="border border-line bg-raise2 px-3 py-2">
            <div className="label-faint">SOURCE OPERATOR</div>
            <div className="mt-0.5 flex items-center justify-between">
              <span className="text-[12px] text-text">{alias}</span>
              <span className="mono-num text-[10px] text-faint">{wallet.slice(0, 10)}…{wallet.slice(-6)}</span>
            </div>
          </div>

          <div>
            <div className="label-faint mb-1">EXECUTION MODE</div>
            <div className="border border-accent/40 bg-accent/5 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-accent2">
                  MANUAL SIGNAL
                </span>
                <Tag tone="accent">NON-CUSTODIAL</Tag>
              </div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-dim">
                The engine notifies you when the operator enters a position; you review and sign
                each mirrored order with your own wallet. Unattended mirroring requires delegated
                signing and is deliberately not part of this tier.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="CAPITAL ALLOCATION">
              <div className="flex gap-px bg-line">
                {(["FIXED", "PROPORTIONAL"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSizingMode(m)}
                    className={cx(
                      "focus-outline h-7 flex-1 text-[9.5px] font-medium tracking-[0.08em] transition-colors",
                      sizingMode === m ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </Field>
            {sizingMode === "FIXED" ? (
              <Field label="AMOUNT PER TRADE (USDC)">
                <NumInput value={fixedUsd} onChange={setFixedUsd} />
              </Field>
            ) : (
              <Field label="% OF SOURCE POSITION">
                <NumInput value={proportionPct} onChange={setProportionPct} />
              </Field>
            )}
            <Field label="MAX POSITION SIZE (USDC)">
              <NumInput value={maxPositionUsd} onChange={setMaxPositionUsd} />
            </Field>
            <Field label="MIN SOURCE TRADE (USDC)">
              <NumInput value={minSourceUsd} onChange={setMinSourceUsd} />
            </Field>
          </div>

          <Field label="SIDE FILTER">
            <div className="flex gap-px bg-line">
              {(["BUY", "SELL", "BOTH"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={cx(
                    "focus-outline h-7 flex-1 text-[10px] font-medium tracking-[0.1em] transition-colors",
                    side === s ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>

          <div className="border border-line bg-raise2 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="label-faint">EXECUTION RATE</span>
              <span className="mono-num text-[12px] text-accent2">{bpsPct(copyRate)}</span>
            </div>
            <div className="mt-1 text-[9px] leading-relaxed text-faint">
              APPLIED ONLY TO SUCCESSFULLY MIRRORED EXECUTION. NO FILL — NO FEE. A SHARE ROUTES
              TO THE SOURCE OPERATOR VIA THE OPERATOR ECONOMY.
            </div>
          </div>
          {allowActivate ? (
            <Btn variant="accent" size="lg" onClick={activate} className="w-full">
              VERIFY CONFIGURATION · ACTIVATE STRATEGY
            </Btn>
          ) : (
            <Btn variant="default" size="lg" onClick={() => { close(); navigate("/pricing"); }} className="w-full">
              TIER LIMIT REACHED — VIEW ACCESS TIERS
            </Btn>
          )}
          <div className="hairline-t flex justify-between pt-2">
            <span className="label-faint">SIGNAL LATENCY ≈ TAPE POLL (≤12S)</span>
            <span className="label-faint">PAUSE / TERMINATE ANYTIME</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      value={value}
      onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
      className="focus-outline mono-num h-7 w-full border border-line bg-raise2 px-2 text-[12px] text-text"
    />
  );
}
