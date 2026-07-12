import { NavLink } from "react-router-dom";
import {
  LayoutGrid,
  Activity,
  Compass,
  ScanSearch,
  Radio,
  ListTree,
  Trophy,
  Wallet,
  Copy,
  Briefcase,
  Landmark,
  ClipboardList,
  Eye,
  GitBranch,
  BellRing,
  FileText,
  CalendarClock,
  Settings,
  UserRound,
  Bot,
  CreditCard,
} from "lucide-react";
import { Mark, Wordmark } from "./Mark";
import { cx } from "../ui/primitives";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: "COMMAND",
    items: [
      { to: "/", label: "Overview", icon: LayoutGrid, end: true },
      { to: "/markets", label: "Live Markets", icon: Activity },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { to: "/discover", label: "Discover", icon: Compass },
      { to: "/scanner", label: "Market Scanner", icon: ScanSearch },
      { to: "/signals", label: "Signals", icon: Radio },
      { to: "/activity", label: "Activity", icon: ListTree },
    ],
  },
  {
    label: "TRADERS",
    items: [
      { to: "/operators", label: "Operator Rankings", icon: Trophy },
      { to: "/wallets", label: "Wallet Intelligence", icon: Wallet },
      { to: "/copy", label: "Copy Engine", icon: Copy },
    ],
  },
  {
    label: "PORTFOLIO",
    items: [
      { to: "/portfolio", label: "Positions", icon: Briefcase },
      { to: "/treasury", label: "Treasury", icon: Landmark },
      { to: "/orders", label: "Orders", icon: ClipboardList },
      { to: "/watchlists", label: "Watchlists", icon: Eye },
    ],
  },
  {
    label: "AUTOMATION",
    items: [
      { to: "/rules", label: "Rules", icon: GitBranch },
      { to: "/alerts", label: "Alerts", icon: BellRing },
    ],
  },
  {
    label: "AI",
    items: [{ to: "/ai", label: "AI Operations", icon: Bot }],
  },
  {
    label: "RESEARCH",
    items: [
      { to: "/research", label: "Briefings", icon: FileText },
      { to: "/timeline", label: "Event Timeline", icon: CalendarClock },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { to: "/account", label: "Account", icon: UserRound },
      { to: "/pricing", label: "Access Tiers", icon: CreditCard },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function NavRail() {
  return (
    <nav className="hairline-r flex h-full w-[196px] shrink-0 flex-col bg-bg">
      <div className="hairline-b flex h-11 shrink-0 items-center gap-2.5 px-3.5">
        <Mark size={15} />
        <Wordmark className="text-text" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {GROUPS.map((g) => (
          <div key={g.label} className="mb-3">
            <div className="label-faint px-3.5 py-1.5">{g.label}</div>
            {g.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    "group relative flex h-[26px] items-center gap-2.5 px-3.5 text-[11.5px] transition-colors duration-120",
                    isActive
                      ? "bg-raise2 text-text"
                      : "text-dim hover:bg-raise hover:text-text",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cx(
                        "absolute inset-y-0 left-0 w-px",
                        isActive ? "bg-accent" : "bg-transparent",
                      )}
                    />
                    <item.icon
                      size={13}
                      strokeWidth={1.5}
                      className={isActive ? "text-accent2" : "text-faint group-hover:text-dim"}
                    />
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
      <div className="hairline-t px-3.5 py-2">
        <div className="label-faint">SENTRY TERMINAL</div>
        <div className="mono-num mt-0.5 text-[9px] text-faint">v0.1.0 · POLYGON MAINNET</div>
      </div>
    </nav>
  );
}
