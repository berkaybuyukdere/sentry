import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Bell, Command, Sun, Moon } from "lucide-react";
import { useAccount } from "wagmi";
import { fmt } from "@sentry-app/polymarket";
import { usePrices } from "../../lib/prices";
import { useTape } from "../../lib/tape";
import { useNotifications } from "../../lib/alerts";
import { useSession } from "../../lib/session";
import { useProvision } from "../../lib/trading/provision";
import { useTheme } from "../../lib/theme";
import { cx, StatusDot } from "../ui/primitives";
import { useCommandK } from "./CommandPalette";
import { WalletButton } from "./WalletModal";

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return (
    <span className="mono-num text-[10px] text-faint">
      {hh}:{mm}:{ss} UTC
    </span>
  );
}

function LinkStatus() {
  const wsStatus = usePrices((s) => s.wsStatus);
  const lastPoll = useTape((s) => s.lastPollAt);
  const tapeError = useTape((s) => s.error);
  const tapeLive = lastPoll !== null && !tapeError;
  const tone = tapeLive ? "pos" : "warn";
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5" title="Data-API tape poll">
        <StatusDot tone={tone} pulse={tapeLive} />
        <span className="label-faint">TAPE</span>
      </div>
      <div className="flex items-center gap-1.5" title="CLOB market stream">
        <StatusDot tone={wsStatus === "connected" ? "pos" : wsStatus === "connecting" ? "warn" : "dim"} pulse={wsStatus === "connected"} />
        <span className="label-faint">STREAM</span>
      </div>
    </div>
  );
}

export function TopBar({ onToggleNotifications }: { onToggleNotifications: () => void }) {
  const navigate = useNavigate();
  const openPalette = useCommandK();
  const unseen = useNotifications((s) => s.items.filter((i) => !i.seen).length);
  const callsign = useSession((s) => s.callsign);
  const { isConnected } = useAccount();
  const { usdcBalance } = useProvision();

  return (
    <header className="hairline-b flex h-11 shrink-0 items-center gap-3 bg-bg px-3">
      {/* universal intelligence search — opens the command layer */}
      <button
        onClick={openPalette}
        className="focus-outline group flex h-7 w-[340px] items-center gap-2 border border-line bg-raise px-2.5 text-left transition-colors hover:border-line-strong"
      >
        <Search size={12} strokeWidth={1.5} className="text-faint" />
        <span className="flex-1 truncate text-[11px] text-faint group-hover:text-dim">
          Search markets, wallets, operators, events…
        </span>
        <kbd className="mono-num flex items-center gap-0.5 border border-line px-1 py-px text-[9px] text-faint">
          <Command size={8} strokeWidth={1.5} />K
        </kbd>
      </button>

      <div className="flex-1" />

      <LinkStatus />
      <div className="hairline-l h-4" />
      <UtcClock />
      <div className="hairline-l h-4" />

      {isConnected && usdcBalance !== null && (
        <>
          <div className="flex items-center gap-1.5" title="USDC available">
            <span className="label-faint">BAL</span>
            <span className="mono-num text-[11px] text-text">{fmt.usd(usdcBalance, { compact: false })}</span>
          </div>
          <div className="hairline-l h-4" />
        </>
      )}

      <ThemeToggle />

      <button
        onClick={onToggleNotifications}
        className="focus-outline relative flex size-7 items-center justify-center border border-transparent text-dim transition-colors hover:border-line-strong hover:text-text"
        title="System notifications"
      >
        <Bell size={13} strokeWidth={1.5} />
        {unseen > 0 && (
          <span
            className={cx(
              "mono-num absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center bg-accent px-0.5 text-[8px] font-semibold text-white",
            )}
          >
            {unseen > 99 ? "99" : unseen}
          </span>
        )}
      </button>

      <WalletButton />

      <button
        onClick={() => navigate("/account")}
        className="focus-outline flex h-7 items-center gap-2 border border-line bg-raise px-2 text-[10px] uppercase tracking-[0.1em] text-dim transition-colors hover:border-line-strong hover:text-text"
        title="Operator account"
      >
        <span className="flex size-4 items-center justify-center bg-raise3 text-[8px] text-accent2">
          {(callsign ?? "OP").slice(0, 2)}
        </span>
        {callsign ?? "OPERATOR"}
      </button>
    </header>
  );
}

function ThemeToggle() {
  const mode = useTheme((s) => s.mode);
  const toggle = useTheme((s) => s.toggle);
  return (
    <button
      onClick={toggle}
      className="focus-outline flex size-7 items-center justify-center border border-transparent text-dim transition-colors hover:border-line-strong hover:text-text"
      title={mode === "dark" ? "Switch to DAYLIGHT OPS" : "Switch to INTEL DARK"}
    >
      {mode === "dark" ? <Sun size={13} strokeWidth={1.5} /> : <Moon size={13} strokeWidth={1.5} />}
    </button>
  );
}
