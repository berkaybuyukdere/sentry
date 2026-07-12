import { useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Trash2, Plus } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { useWatchlists } from "../lib/watchlists";
import { canCreateWatchlist, useBilling, tierById } from "../lib/billing";
import { useMarkets } from "../lib/queries";
import { useTape } from "../lib/tape";
import { useSignals } from "../lib/signals";
import { Panel, Btn, Delta, Empty, Tag, severityTone, cx } from "../components/ui/primitives";

/** Watchlists — live monitoring workspaces over markets + wallets + narratives. */
export function Watchlists() {
  const { lists, create, remove } = useWatchlists();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const active = lists.find((l) => l.id === activeId) ?? lists[0] ?? null;
  const tier = useBilling((s) => s.tier);
  const allowCreate = canCreateWatchlist(lists.length);
  const cap = tierById(tier).entitlements.watchlists;

  return (
    <div className="flex h-full">
      {/* list rail */}
      <div className="hairline-r flex w-[220px] shrink-0 flex-col">
        <div className="hairline-b flex h-11 items-center px-3">
          <span className="label">INTELLIGENCE WATCHLISTS</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {lists.map((l) => (
            <button
              key={l.id}
              onClick={() => setActiveId(l.id)}
              className={cx(
                "hairline-b relative block w-full px-3 py-2.5 text-left transition-colors",
                active?.id === l.id ? "bg-raise2" : "hover:bg-raise",
              )}
            >
              {active?.id === l.id && <span className="absolute inset-y-0 left-0 w-px bg-accent" />}
              <div className="text-[11.5px] text-text">{l.name}</div>
              <div className="label-faint mt-0.5">
                {l.markets.length}M · {l.wallets.length}W
              </div>
            </button>
          ))}
        </div>
        <div className="hairline-t p-2">
          {allowCreate ? (
            <div className="flex gap-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    setActiveId(create(newName.trim()));
                    setNewName("");
                  }
                }}
                placeholder="NEW LIST"
                className="focus-outline h-7 min-w-0 flex-1 border border-line bg-raise px-2 text-[10px] uppercase tracking-[0.08em] text-text placeholder:text-faint"
              />
              <Btn
                size="md"
                variant="accent"
                disabled={!newName.trim()}
                onClick={() => {
                  setActiveId(create(newName.trim()));
                  setNewName("");
                }}
              >
                <Plus size={11} strokeWidth={1.5} />
              </Btn>
            </div>
          ) : (
            <Link to="/pricing" className="block border border-warn/40 bg-warn/5 px-2 py-1.5 text-center">
              <span className="label text-warn">TIER LIMIT — {cap} LISTS</span>
              <div className="mt-0.5 text-[9px] uppercase tracking-[0.1em] text-faint">UPGRADE FOR UNLIMITED</div>
            </Link>
          )}
        </div>
      </div>

      {/* workspace */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!active ? (
          <Empty
            label="NO WATCHLISTS DEFINED"
            hint="Create a list, then assign markets and wallets from anywhere via WATCH."
          />
        ) : (
          <WatchlistWorkspace key={active.id} listId={active.id} onRemove={() => remove(active.id)} />
        )}
      </div>
    </div>
  );
}

function WatchlistWorkspace({ listId, onRemove }: { listId: string; onRemove: () => void }) {
  const list = useWatchlists((s) => s.lists.find((l) => l.id === listId))!;
  const removeMarket = useWatchlists((s) => s.removeMarket);
  const removeWallet = useWatchlists((s) => s.removeWallet);
  const { data: markets } = useMarkets({ limit: 400 }, 30_000);
  const trades = useTape((s) => s.trades);
  const signals = useSignals((s) => s.signals);
  const navigate = useNavigate();

  const watchedMarkets = useMemo(() => {
    const slugs = new Set(list.markets.map((m) => m.slug));
    return (markets ?? []).filter((m) => slugs.has(m.slug));
  }, [markets, list.markets]);

  const walletSet = useMemo(() => new Set(list.wallets.map((w) => w.address)), [list.wallets]);
  const conditionSet = useMemo(() => new Set(list.markets.map((m) => m.conditionId)), [list.markets]);

  // live event timeline: tape rows + signals scoped to this list
  const events = useMemo(() => {
    const tapeEvents = trades
      .filter((t) => walletSet.has(t.proxyWallet.toLowerCase()) || conditionSet.has(t.conditionId))
      .slice(0, 30)
      .map((t) => ({
        ts: t.timestamp,
        kind: walletSet.has(t.proxyWallet.toLowerCase()) ? ("WALLET" as const) : ("MARKET" as const),
        text: `${t.name || fmt.shortAddr(t.proxyWallet)} ${t.side} ${t.outcome} — ${t.title}`,
        usd: t.size * t.price,
        href: `/market/${t.slug}`,
      }));
    const sigEvents = signals
      .filter((s) => s.conditionId && conditionSet.has(s.conditionId))
      .slice(0, 15)
      .map((s) => ({
        ts: s.ts,
        kind: "SIGNAL" as const,
        text: `${s.type.replaceAll("_", " ")} — ${s.marketTitle}: ${s.title}`,
        usd: s.usd,
        href: s.marketSlug ? `/market/${s.marketSlug}` : "/signals",
      }));
    return [...tapeEvents, ...sigEvents].sort((a, b) => b.ts - a.ts).slice(0, 40);
  }, [trades, signals, walletSet, conditionSet]);

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">{list.name.toUpperCase()}</h1>
        <span className="mono-num text-[10px] text-faint">
          {list.markets.length} MARKETS · {list.wallets.length} WALLETS
        </span>
        <div className="flex-1" />
        <Btn size="sm" variant="danger" onClick={onRemove}>
          <Trash2 size={10} strokeWidth={1.5} /> DELETE LIST
        </Btn>
      </div>

      <div className="grid grid-cols-3 gap-px bg-line p-px">
        <Panel className="col-span-2 border-0" title="MONITORED MARKETS" pad={false}>
          {!watchedMarkets.length ? (
            <Empty label="NO MARKETS ASSIGNED" hint="Use WATCH on any market row or detail page." />
          ) : (
            <table className="w-full">
              <tbody>
                {watchedMarkets.map((m) => (
                  <tr
                    key={m.id}
                    onClick={() => navigate(`/market/${m.slug}`)}
                    className="hairline-b h-10 cursor-pointer row-hover"
                  >
                    <td className="max-w-0 truncate px-3 text-[11.5px] text-text">{m.question}</td>
                    <td className="mono-num w-16 px-2 text-right text-[12px] text-accent2">{fmt.pct(m.probability)}</td>
                    <td className="w-16 px-2 text-right text-[11px]"><Delta value={m.delta24h} suffix="pp" /></td>
                    <td className="mono-num w-20 px-2 text-right text-[10.5px] text-dim">{fmt.usd(m.volume24h)}</td>
                    <td className="w-8 px-2 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeMarket(list.id, m.slug);
                        }}
                        className="text-faint hover:text-neg"
                        title="Remove from list"
                      >
                        <Trash2 size={11} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel className="border-0" title="MONITORED WALLETS" pad={false}>
          {!list.wallets.length ? (
            <Empty label="NO WALLETS ASSIGNED" hint="Use WATCH on any operator dossier." />
          ) : (
            <div className="flex flex-col">
              {list.wallets.map((w) => (
                <div key={w.address} className="hairline-b flex items-center gap-2 px-3 py-2">
                  <Link
                    to={`/wallet/${w.address}`}
                    className="min-w-0 flex-1 truncate text-[11px] text-text hover:text-accent2"
                  >
                    {w.alias || fmt.shortAddr(w.address)}
                  </Link>
                  <span className="mono-num text-[9px] text-faint">{fmt.shortAddr(w.address)}</span>
                  <button
                    onClick={() => removeWallet(list.id, w.address)}
                    className="text-faint hover:text-neg"
                  >
                    <Trash2 size={11} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="col-span-3 border-0" title="LIVE EVENTS — SCOPED TIMELINE" pad={false}>
          {!events.length ? (
            <Empty label="NO SCOPED ACTIVITY YET" hint="Fills and signals touching this list stream in live." />
          ) : (
            <div className="flex max-h-[320px] flex-col overflow-y-auto">
              {events.map((e, i) => (
                <button
                  key={`${e.ts}-${i}`}
                  onClick={() => navigate(e.href)}
                  className="hairline-b row-hover flex items-center gap-3 px-4 py-2 text-left"
                >
                  <span className="mono-num w-10 shrink-0 text-[10px] text-faint">{fmt.utcClock(e.ts)}</span>
                  <Tag tone={e.kind === "SIGNAL" ? severityTone("HIGH") : e.kind === "WALLET" ? "accent" : "dim"}>
                    {e.kind}
                  </Tag>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{e.text}</span>
                  {e.usd > 0 && <span className="mono-num shrink-0 text-[10.5px] text-text">{fmt.usd(e.usd)}</span>}
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
