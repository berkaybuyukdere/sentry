import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { useNotifications, type Notification } from "../../lib/alerts";
import { Btn, Empty, Tag, cx } from "../ui/primitives";

const kindTone: Record<Notification["kind"], "accent" | "warn" | "pos" | "dim" | "neg"> = {
  SIGNAL: "accent",
  RULE: "warn",
  COPY: "pos",
  ORDER: "accent",
  SYSTEM: "dim",
};

export function NotificationDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = useNotifications((s) => s.items);
  const markAllSeen = useNotifications((s) => s.markAllSeen);
  const clear = useNotifications((s) => s.clear);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      const t = setTimeout(markAllSeen, 1200);
      return () => clearTimeout(t);
    }
  }, [open, markAllSeen]);

  if (!open) return null;

  return (
    <aside className="hairline-l flex w-[320px] shrink-0 flex-col bg-raise">
      <header className="hairline-b flex h-9 shrink-0 items-center justify-between px-3">
        <span className="label">SYSTEM EVENTS</span>
        <div className="flex items-center gap-2">
          <Btn size="sm" variant="ghost" onClick={clear}>
            CLEAR
          </Btn>
          <button onClick={onClose} className="focus-outline text-faint hover:text-text">
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <Empty label="NO EVENTS" hint="Signals, rule triggers and order events appear here." />
        ) : (
          items.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                if (n.href) navigate(n.href);
                onClose();
              }}
              className={cx(
                "hairline-b row-hover block w-full px-3 py-2.5 text-left",
                !n.seen && "bg-accent/[0.04]",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <Tag tone={kindTone[n.kind]}>{n.kind}</Tag>
                <span className="mono-num text-[9px] text-faint">
                  {fmt.timeAgo(Math.floor(n.ts / 1000))}
                </span>
              </div>
              <div className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-text">
                {n.title}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-dim">{n.body}</div>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
