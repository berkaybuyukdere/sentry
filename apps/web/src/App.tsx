import { useEffect, useRef, useState } from "react";
import { Routes, Route } from "react-router-dom";
import { useSession } from "./lib/session";
import { useSignalEngine, useSignals } from "./lib/signals";
import { useAiDeskEngine } from "./lib/aiDesk";
import { useMarkets } from "./lib/queries";
import { evaluateRules, useNotifications } from "./lib/alerts";
import { NavRail } from "./components/shell/NavRail";
import { TopBar } from "./components/shell/TopBar";
import { NotificationDrawer } from "./components/shell/NotificationDrawer";
import { CommandPalette } from "./components/shell/CommandPalette";
import { ExecutionPanel } from "./components/market/ExecutionPanel";
import { WatchlistPicker } from "./components/market/WatchlistPicker";
import { CopySetup } from "./components/market/CopySetup";
import { Access } from "./screens/Access";
import { CommandCenter } from "./screens/CommandCenter";
import { LiveMarkets } from "./screens/LiveMarkets";
import { MarketDetail } from "./screens/MarketDetail";
import { Discover } from "./screens/Discover";
import { SignalsScreen } from "./screens/Signals";
import { ActivityScreen } from "./screens/Activity";
import { Operators } from "./screens/Operators";
import { WalletIntel } from "./screens/WalletIntel";
import { WalletIndex } from "./screens/WalletIndex";
import { CopyEngine } from "./screens/CopyEngine";
import { Portfolio } from "./screens/Portfolio";
import { Treasury } from "./screens/Treasury";
import { Pricing } from "./screens/Pricing";
import { AiOperations } from "./screens/AiOperations";
import { OrdersScreen } from "./screens/Orders";
import { Watchlists } from "./screens/Watchlists";
import { RulesScreen } from "./screens/Rules";
import { AlertsScreen } from "./screens/Alerts";
import { Research } from "./screens/Research";
import { Timeline } from "./screens/Timeline";
import { Account } from "./screens/Account";
import { SettingsScreen } from "./screens/Settings";

/** Background evaluation of user monitoring rules against live state. */
function useRuleEngine() {
  const { data: markets } = useMarkets({ limit: 300 }, 45_000);
  const signals = useSignals((s) => s.signals);
  const firstSeen = useSignals((s) => s.firstSeen);
  const notify = useNotifications((s) => s.push);
  const lastRun = useRef(0);

  useEffect(() => {
    if (!markets?.length) return;
    const now = Date.now();
    if (now - lastRun.current < 20_000) return;
    lastRun.current = now;
    const freshSignals = signals.filter((s) => (firstSeen[s.id] ?? 0) > now - 5 * 60_000);
    for (const { rule, message } of evaluateRules(markets, freshSignals, now)) {
      notify({ kind: "RULE", title: `RULE ${rule.id} TRIGGERED`, body: message, href: "/rules" });
    }
  }, [markets, signals, firstSeen, notify]);
}

function WorkspaceShell() {
  useSignalEngine();
  useRuleEngine();
  useAiDeskEngine();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onToggleNotifications={() => setDrawerOpen((v) => !v)} />
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<CommandCenter />} />
              <Route path="/markets" element={<LiveMarkets />} />
              <Route path="/scanner" element={<LiveMarkets scanner />} />
              <Route path="/market/:slug" element={<MarketDetail />} />
              <Route path="/discover" element={<Discover />} />
              <Route path="/signals" element={<SignalsScreen />} />
              <Route path="/activity" element={<ActivityScreen />} />
              <Route path="/operators" element={<Operators />} />
              <Route path="/wallets" element={<WalletIndex />} />
              <Route path="/wallet/:address" element={<WalletIntel />} />
              <Route path="/copy" element={<CopyEngine />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/treasury" element={<Treasury />} />
              <Route path="/orders" element={<OrdersScreen />} />
              <Route path="/watchlists" element={<Watchlists />} />
              <Route path="/rules" element={<RulesScreen />} />
              <Route path="/alerts" element={<AlertsScreen />} />
              <Route path="/research" element={<Research />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/ai" element={<AiOperations />} />
              <Route path="/account" element={<Account />} />
              <Route path="/settings" element={<SettingsScreen />} />
            </Routes>
          </main>
          <NotificationDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        </div>
      </div>
      <CommandPalette />
      <ExecutionPanel />
      <WatchlistPicker />
      <CopySetup />
    </div>
  );
}

export default function App() {
  const callsign = useSession((s) => s.callsign);
  const booted = useSession((s) => s.booted);
  if (!callsign || !booted) return <Access />;
  return <WorkspaceShell />;
}
