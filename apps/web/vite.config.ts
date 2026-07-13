import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import nodemailer from "nodemailer";

/**
 * SENTRY live-ops mailer — dev-server middleware at POST /__sentry/mail.
 *
 * The terminal is a browser app and browsers cannot speak SMTP, so the Vite
 * dev server (a Node process that is always running while the terminal runs)
 * carries the mail bridge. Credentials come from apps/web/.env.local
 * (gitignored — NEVER commit the Gmail app password):
 *
 *   SENTRY_MAIL_USER=you@gmail.com        # Gmail account that sends
 *   SENTRY_MAIL_PASS=xxxxxxxxxxxxxxxx     # 16-char Gmail app password
 *   SENTRY_MAIL_TO=dest@example.com       # recipient
 *
 * The browser only ever POSTs event JSON; the password never leaves Node.
 */
function sentryMailer(env: Record<string, string>): Plugin {
  const user = env.SENTRY_MAIL_USER;
  const pass = (env.SENTRY_MAIL_PASS ?? "").replaceAll(" ", "");
  const to = env.SENTRY_MAIL_TO;
  const configured = Boolean(user && pass && to);
  const transport = configured
    ? nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } })
    : null;

  // soft rate limit — a runaway loop must not torch the Gmail send quota
  const stamps: number[] = [];
  const allow = () => {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
    if (stamps.length >= 10) return false;
    stamps.push(now);
    return true;
  };

  const usd = (v: unknown, sign = false) =>
    typeof v === "number" && Number.isFinite(v) ? `${sign && v >= 0 ? "+" : ""}$${v.toFixed(2)}` : "—";

  const TONE: Record<string, string> = {
    ENTRY: "#7aa2f7",
    CLOSE: "#9ece6a",
    TARGET: "#9ece6a",
    LOSS_BRAKE: "#f7768e",
    LOCK: "#e0af68",
    FAULT: "#f7768e",
  };

  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  const render = (ev: any): string => {
    const tone = ev.kind === "CLOSE" && typeof ev.pnlUsd === "number" && ev.pnlUsd < 0 ? "#f7768e" : (TONE[ev.kind] ?? "#7aa2f7");
    const k = ev.kpi ?? {};
    const kpiRow = (label: string, value: string, color = "#c0caf5") =>
      `<tr><td style="padding:6px 14px;color:#565f89;font-size:10px;letter-spacing:.14em;">${label}</td><td style="padding:6px 14px;color:${color};font-size:12px;text-align:right;">${value}</td></tr>`;
    const reasons = Array.isArray(ev.reasons) && ev.reasons.length
      ? `<div style="margin-top:10px;border-top:1px solid #1f2335;padding-top:8px;">${ev.reasons
          .map((r: string) => `<div style="color:#565f89;font-size:11px;line-height:1.6;">&mdash; ${esc(r)}</div>`)
          .join("")}</div>`
      : "";
    const trade = ev.market
      ? `<div style="margin-top:12px;padding:12px 14px;border:1px solid #1f2335;background:#16161e;">
           <div style="color:#c0caf5;font-size:13px;line-height:1.5;">${esc(ev.market)}</div>
           <div style="margin-top:6px;color:#565f89;font-size:11px;">
             ${ev.outcome ? `<span style="color:#9ece6a;">${esc(String(ev.outcome).toUpperCase())}</span> · ` : ""}
             ${typeof ev.entryPrice === "number" ? `${(ev.entryPrice * 100).toFixed(1)}&cent;` : ""}
             ${typeof ev.exitPrice === "number" ? ` &rarr; ${(ev.exitPrice * 100).toFixed(1)}&cent;` : ""}
             ${typeof ev.sizeUsd === "number" ? ` · ${usd(ev.sizeUsd)}` : ""}
             ${typeof ev.pnlUsd === "number" ? ` · <span style="color:${ev.pnlUsd >= 0 ? "#9ece6a" : "#f7768e"};">${usd(ev.pnlUsd, true)} NET</span>` : ""}
           </div>${reasons}
         </div>`
      : "";
    return `<!doctype html><html><body style="margin:0;padding:0;background:#0d0e14;">
      <div style="max-width:560px;margin:0 auto;padding:28px 20px;font-family:'SF Mono',Menlo,Consolas,monospace;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr><td style="padding-bottom:16px;">
            <span style="color:#c0caf5;font-size:15px;letter-spacing:.32em;font-weight:600;">SENTRY</span>
            <span style="color:#565f89;font-size:10px;letter-spacing:.18em;"> &nbsp;// LIVE OPERATIONS</span>
          </td></tr>
          <tr><td style="border-left:2px solid ${tone};padding:10px 14px;background:#16161e;">
            <div style="color:${tone};font-size:12px;letter-spacing:.16em;font-weight:600;">${esc(ev.title)}</div>
            <div style="margin-top:6px;color:#a9b1d6;font-size:12px;line-height:1.6;">${esc(ev.detail)}</div>
          </td></tr>
        </table>
        ${trade}
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:12px;border:1px solid #1f2335;background:#16161e;">
          ${kpiRow("WALLET", usd(k.walletUsd))}
          ${kpiRow("SESSION P&amp;L", usd(k.sessionPnlUsd, true), typeof k.sessionPnlUsd === "number" ? (k.sessionPnlUsd >= 0 ? "#9ece6a" : "#f7768e") : "#c0caf5")}
          ${kpiRow("REALIZED (LEDGER)", usd(k.realizedUsd, true), typeof k.realizedUsd === "number" ? (k.realizedUsd >= 0 ? "#9ece6a" : "#f7768e") : "#c0caf5")}
          ${kpiRow("OPEN POSITIONS", esc(String(k.openCount ?? "—")))}
          ${kpiRow("PROFIT BANKED", usd(k.lockedUsd), "#e0af68")}
          ${kpiRow("TARGET", usd(k.targetUsd))}
        </table>
        <div style="margin-top:16px;color:#3b4261;font-size:9px;letter-spacing:.14em;">
          SENTRY TERMINAL · POLYGON MAINNET · ANONYMOUS / NON-CUSTODIAL · ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC
        </div>
      </div>
    </body></html>`;
  };

  return {
    name: "sentry-mailer",
    configureServer(server) {
      server.middlewares.use("/__sentry/mail", (req, res) => {
        if (req.method === "GET") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ configured }));
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        // custom header = mandatory CORS preflight for any cross-origin
        // caller, and this middleware never answers OPTIONS with approval —
        // a hostile page open in the operator's browser cannot forge alerts
        if (req.headers["x-sentry-mail"] !== "terminal") {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        if (!transport) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "mailer not configured — set SENTRY_MAIL_* in apps/web/.env.local" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let ev: any;
          try {
            ev = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "bad json" }));
            return;
          }
          if (!ev?.kind || !ev?.title) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "kind and title required" }));
            return;
          }
          if (!allow()) {
            res.statusCode = 429;
            res.end(JSON.stringify({ error: "rate limited" }));
            return;
          }
          transport
            .sendMail({
              from: `SENTRY LIVE OPS <${user}>`,
              to,
              subject: `SENTRY LIVE — ${String(ev.title).replace(/[\r\n]+/g, " ")}${ev.market ? ` — ${String(ev.market).replace(/[\r\n]+/g, " ").slice(0, 60)}` : ""}`,
              html: render(ev),
            })
            .then(() => {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            })
            .catch((e: Error) => {
              console.error("[sentry-mailer] send failed:", e.message);
              res.statusCode = 502;
              res.end(JSON.stringify({ error: e.message }));
            });
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  return {
    plugins: [react(), tailwindcss(), sentryMailer(env)],
    server: {
      port: 5180,
      strictPort: true,
    },
    build: {
      target: "es2022",
      chunkSizeWarningLimit: 1400,
    },
  };
});
