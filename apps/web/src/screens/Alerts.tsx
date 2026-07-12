import { useNavigate } from "react-router-dom";
import { fmt } from "@sentry-app/polymarket";
import { useNotifications, type Notification } from "../lib/alerts";
import { Btn, Empty, Tag, cx } from "../components/ui/primitives";

const kindTone: Record<Notification["kind"], "accent" | "warn" | "pos" | "dim" | "neg"> = {
  SIGNAL: "accent",
  RULE: "warn",
  COPY: "pos",
  ORDER: "accent",
  SYSTEM: "dim",
};

/** Alerts — the full system event ledger (notification history). */
export function AlertsScreen() {
  const items = useNotifications((s) => s.items);
  const clear = useNotifications((s) => s.clear);
  const markAllSeen = useNotifications((s) => s.markAllSeen);
  const navigate = useNavigate();

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">ALERTS — EVENT LEDGER</h1>
        <span className="mono-num text-[10px] text-faint">{items.length} EVENTS THIS SESSION</span>
        <div className="flex-1" />
        <Btn size="sm" variant="ghost" onClick={markAllSeen}>MARK SEEN</Btn>
        <Btn size="sm" variant="danger" onClick={clear}>PURGE</Btn>
      </div>

      {!items.length ? (
        <Empty
          label="LEDGER EMPTY"
          hint="Rule triggers, signals, copy events and order confirmations accumulate here."
        />
      ) : (
        <div className="flex flex-col">
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => n.href && navigate(n.href)}
              className={cx(
                "hairline-b row-hover flex items-center gap-3 px-4 py-2.5 text-left",
                !n.seen && "bg-accent/[0.04]",
              )}
            >
              <span className="mono-num w-12 shrink-0 text-[10px] text-faint">
                {fmt.utcClock(Math.floor(n.ts / 1000))}
              </span>
              <Tag tone={kindTone[n.kind]}>{n.kind}</Tag>
              <span className="w-[210px] shrink-0 truncate text-[11px] font-medium uppercase tracking-[0.04em] text-text">
                {n.title}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{n.body}</span>
              {!n.seen && <span className="size-1 shrink-0 bg-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
