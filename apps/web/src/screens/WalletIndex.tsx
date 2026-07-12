import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { isAddress } from "viem";
import { SearchCode } from "lucide-react";
import { useLeaderboard } from "../lib/queries";
import { fmt } from "@sentry-app/polymarket";
import { Panel, Loading, cx } from "../components/ui/primitives";

/** Wallet Intelligence index — direct address lookup + notable operator shortcuts. */
export function WalletIndex() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();
  const { data: lb, isLoading } = useLeaderboard("7d", 20);
  const valid = isAddress(value.trim());

  const go = () => valid && navigate(`/wallet/${value.trim().toLowerCase()}`);

  return (
    <div className="flex flex-col">
      <div className="hairline-b px-4 py-3">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">WALLET INTELLIGENCE</h1>
        <p className="mt-1 text-[11px] text-dim">
          Open a full operator dossier for any Polygon wallet active on Polymarket.
        </p>
      </div>
      <div className="p-4">
        <div className="flex max-w-[560px] gap-1.5">
          <div className="relative flex-1">
            <SearchCode size={13} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
              placeholder="0x… WALLET ADDRESS"
              className="focus-outline mono-num h-9 w-full border border-line bg-raise pl-8 pr-3 text-[12px] text-text placeholder:text-faint"
            />
          </div>
          <button
            onClick={go}
            disabled={!valid}
            className="focus-outline h-9 border border-accent/60 bg-accent/15 px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-accent2 transition-colors hover:bg-accent/25 disabled:opacity-30"
          >
            OPEN DOSSIER
          </button>
        </div>
        {value.trim() && !valid && (
          <div className="mt-1.5 text-[10px] uppercase tracking-[0.1em] text-warn2">
            NOT A VALID EVM ADDRESS
          </div>
        )}

        <div className="mt-6 max-w-[860px]">
          <Panel title="NOTABLE OPERATORS — 7D COHORT" pad={false}>
            {isLoading ? (
              <Loading />
            ) : (
              <div className="grid grid-cols-2">
                {(lb ?? []).map((e) => (
                  <button
                    key={e.proxyWallet}
                    onClick={() => navigate(`/wallet/${e.proxyWallet.toLowerCase()}`)}
                    className="hairline-b row-hover flex items-center gap-3 px-3 py-2 text-left odd:border-r odd:border-r-line"
                  >
                    <span className="mono-num w-6 text-[10px] text-faint">{String(e.rank).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{e.userName || fmt.shortAddr(e.proxyWallet)}</span>
                    <span className={cx("mono-num text-[11px]", e.pnl >= 0 ? "text-pos" : "text-neg")}>
                      {fmt.usd(e.pnl, { sign: true })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
