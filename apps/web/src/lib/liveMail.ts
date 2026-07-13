/**
 * LIVE e-mail dispatch — queued, retried POSTs to the dev server's mailer
 * middleware (`/__sentry/mail`, see vite.config.ts). The trading engine must
 * NEVER block or throw on mail: a dead SMTP link cannot be allowed to touch
 * order flow, so sends are fire-and-forget and failures re-queue for a retry
 * sweep instead of being lost (halt/close mails are one-shot events — the
 * call site never calls again, so the queue owns redelivery).
 *
 * Credentials live server-side only (apps/web/.env.local, gitignored) — the
 * browser never sees the Gmail app password. The custom x-sentry-mail header
 * forces a CORS preflight for any cross-origin caller, which the middleware
 * never approves — a hostile webpage in the same browser can't forge alerts.
 */

export interface LiveMailKpi {
  walletUsd?: number | null;
  openCount: number;
  realizedUsd: number;
  lockedUsd: number;
  targetUsd: number;
  sessionPnlUsd?: number | null;
}

export interface LiveMailEvent {
  kind: "ENTRY" | "CLOSE" | "TARGET" | "LOSS_BRAKE" | "LOCK" | "FAULT";
  /** dedupe key — one mail per unique key per page session */
  key: string;
  title: string;
  detail: string;
  market?: string;
  outcome?: string;
  entryPrice?: number;
  exitPrice?: number;
  sizeUsd?: number;
  pnlUsd?: number;
  reason?: string;
  /** decision rationale lines (includes elite/whale-flow analysis) */
  reasons?: string[];
  kpi?: LiveMailKpi;
}

const enqueued = new Set<string>();
const queue: LiveMailEvent[] = [];
const MAX_QUEUE = 50;
const RETRY_MS = 45_000;
let draining = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function remove(ev: LiveMailEvent): void {
  const i = queue.indexOf(ev);
  if (i >= 0) queue.splice(i, 1);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const ev = queue[0];
      try {
        const r = await fetch("/__sentry/mail", {
          method: "POST",
          headers: { "content-type": "application/json", "x-sentry-mail": "terminal" },
          body: JSON.stringify(ev),
        });
        if (!r.ok) {
          // 4xx other than rate-limit is a payload problem — drop, don't loop
          if (r.status >= 400 && r.status < 500 && r.status !== 429) {
            console.info(`%c[SENTRY MAIL] ${ev.kind} dropped — server said ${r.status}`, "color:#b80");
            remove(ev);
            continue;
          }
          throw new Error(String(r.status));
        }
        remove(ev);
      } catch {
        // transient (rate limit / SMTP hiccup / server down): keep the event
        // at the head of the queue and retry the whole drain later
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void drain();
          }, RETRY_MS);
        }
        return;
      }
    }
  } finally {
    draining = false;
  }
}

export function sendLiveMail(ev: LiveMailEvent): void {
  if (enqueued.has(ev.key)) return;
  enqueued.add(ev.key);
  if (queue.length >= MAX_QUEUE) queue.shift(); // shed oldest, never block
  queue.push(ev);
  void drain();
}
