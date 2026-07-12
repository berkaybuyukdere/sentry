import { useEffect, useState } from "react";
import { RefreshCw, Wallet as WalletIcon } from "lucide-react";
import { useAccount, useConnect, type Connector } from "wagmi";
import { useSession, type AccessMethod } from "../lib/session";
import { Mark } from "../components/shell/Mark";
import { cx } from "../components/ui/primitives";

/** SYSTEM ACCESS — three anonymous entry channels.
 *  ANONYMOUS: machine-generated callsign, nothing transmitted.
 *  WALLET:    callsign derived from your address; wallet doubles as trading identity.
 *  GOOGLE:    one-way hash of the Google identity → callsign; token discarded,
 *             no email or name is ever stored. Anonymity holds on every path. */

const BOOT_STEPS = [
  { label: "MARKET STREAM", done: "CONNECTED" },
  { label: "WALLET INDEX", done: "SYNCHRONIZED" },
  { label: "SIGNAL ENGINE", done: "ACTIVE" },
  { label: "COMMAND LAYER", done: "READY" },
];

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

function generateCallsign(): string {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return `OP-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

async function hashedCallsign(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = [...new Uint8Array(digest)].slice(0, 2).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `OP-${hex.toUpperCase()}`;
}

export function Access() {
  const { callsign, authenticate, setBooted } = useSession();
  const [phase, setPhase] = useState<"auth" | "boot">(callsign ? "boot" : "auth");
  const [channel, setChannel] = useState<AccessMethod>("ANONYMOUS");
  const [generated, setGenerated] = useState(generateCallsign);
  const [step, setStep] = useState(0);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();

  useEffect(() => {
    if (phase !== "boot") return;
    if (step >= BOOT_STEPS.length) {
      const t = setTimeout(setBooted, 420);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), 380);
    return () => clearTimeout(t);
  }, [phase, step, setBooted]);

  // WALLET channel: once connected, derive callsign from the address and enter
  useEffect(() => {
    if (channel === "WALLET" && isConnected && address && phase === "auth") {
      authenticate(`OP-${address.slice(2, 6).toUpperCase()}`, "WALLET");
      setPhase("boot");
    }
  }, [channel, isConnected, address, phase, authenticate]);

  // GOOGLE channel: load GIS and render the button when configured
  useEffect(() => {
    if (channel !== "GOOGLE" || !GOOGLE_CLIENT_ID || phase !== "auth") return;
    const existing = document.getElementById("gis-script");
    const init = () => {
      const google = (window as unknown as { google?: { accounts: { id: { initialize: (o: object) => void; renderButton: (el: HTMLElement, o: object) => void } } } }).google;
      const host = document.getElementById("google-entry");
      if (!google || !host) return;
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (resp: { credential: string }) => {
          try {
            const payload = JSON.parse(atob(resp.credential.split(".")[1])) as { sub?: string; email?: string };
            const cs = await hashedCallsign(payload.sub ?? payload.email ?? resp.credential);
            // identity token is discarded here — only the derived callsign persists
            authenticate(cs, "GOOGLE");
            setPhase("boot");
          } catch {
            setGoogleError("IDENTITY DECODE FAULT");
          }
        },
      });
      google.accounts.id.renderButton(host, { theme: "filled_black", size: "medium", width: 280, text: "continue_with" });
    };
    if (existing) {
      init();
      return;
    }
    const s = document.createElement("script");
    s.id = "gis-script";
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = init;
    s.onerror = () => setGoogleError("GOOGLE IDENTITY SERVICE UNREACHABLE");
    document.head.appendChild(s);
  }, [channel, phase, authenticate]);

  const enterAnonymous = () => {
    authenticate(generated, "ANONYMOUS");
    setPhase("boot");
  };

  const channels: { key: AccessMethod; label: string }[] = [
    { key: "ANONYMOUS", label: "ANONYMOUS" },
    { key: "WALLET", label: "WALLET" },
    { key: "GOOGLE", label: "GOOGLE" },
  ];

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg">
      <div className="w-[360px]">
        <div className="mb-10 flex items-center justify-center gap-3">
          <Mark size={18} />
          <span className="text-[13px] font-semibold tracking-[0.28em] text-text">SENTRY</span>
        </div>

        {phase === "auth" ? (
          <div className="panel border-line-strong">
            <header className="hairline-b flex h-8 items-center justify-between px-3">
              <span className="label">SYSTEM ACCESS</span>
              <span className="label-faint">ZERO PII · ALL CHANNELS</span>
            </header>

            <div className="hairline-b grid grid-cols-3 gap-px bg-line">
              {channels.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setChannel(c.key)}
                  className={cx(
                    "focus-outline h-8 text-[9.5px] font-medium tracking-[0.14em] transition-colors",
                    channel === c.key ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-4 p-4">
              {channel === "ANONYMOUS" && (
                <>
                  <div>
                    <div className="label-faint mb-1.5">ASSIGNED CALLSIGN</div>
                    <div className="flex gap-1.5">
                      <div className="mono-num flex h-9 flex-1 items-center border border-line bg-raise2 px-3 text-[14px] tracking-[0.18em] text-accent2">
                        {generated}
                      </div>
                      <button
                        onClick={() => setGenerated(generateCallsign())}
                        className="focus-outline flex size-9 items-center justify-center border border-line bg-raise2 text-dim transition-colors hover:border-line-strong hover:text-text"
                        title="Generate new identity"
                      >
                        <RefreshCw size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-faint">
                      Generated locally, never transmitted. No email, no password, no registration.
                    </p>
                  </div>
                  <button
                    onClick={enterAnonymous}
                    className="focus-outline h-9 w-full border border-accent/70 bg-accent/15 text-[11px] font-medium uppercase tracking-[0.2em] text-accent2 transition-colors hover:bg-accent/25"
                  >
                    ENTER ANONYMOUS SESSION
                  </button>
                </>
              )}

              {channel === "WALLET" && (
                <>
                  <p className="text-[10px] leading-relaxed text-faint">
                    Your callsign derives from your address; the wallet doubles as trading
                    identity. No signature is requested at entry.
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {connectors
                      .filter((c: Connector) => c.icon || c.id !== "injected")
                      .map((c: Connector) => (
                        <button
                          key={c.uid}
                          disabled={isPending}
                          onClick={() => connect({ connector: c })}
                          className="focus-outline flex h-9 items-center gap-2.5 border border-line bg-raise2 px-3 text-[11px] uppercase tracking-[0.08em] text-text transition-colors hover:border-accent/60 hover:bg-raise3 disabled:opacity-40"
                        >
                          {c.icon ? (
                            <img src={c.icon} alt="" className="size-4" />
                          ) : (
                            <WalletIcon size={12} strokeWidth={1.5} className="text-accent2" />
                          )}
                          {c.name}
                        </button>
                      ))}
                  </div>
                </>
              )}

              {channel === "GOOGLE" && (
                <>
                  <p className="text-[10px] leading-relaxed text-faint">
                    The Google identity is hashed one-way into a callsign and the token is
                    discarded — SENTRY never stores your email or name. Anonymity holds.
                  </p>
                  {GOOGLE_CLIENT_ID ? (
                    <div id="google-entry" className="flex justify-center py-1" />
                  ) : (
                    <div className="border border-warn/40 bg-warn/5 px-3 py-2.5">
                      <span className="label text-warn">CHANNEL NOT PROVISIONED</span>
                      <p className="mt-1 text-[10px] leading-relaxed text-dim">
                        Set <span className="mono-num">VITE_GOOGLE_CLIENT_ID</span> in
                        apps/web/.env.local to enable Google entry. The other channels remain
                        fully operational.
                      </p>
                    </div>
                  )}
                  {googleError && (
                    <div className="border border-neg/40 bg-neg/5 px-2.5 py-1.5 text-[10px] text-neg2">{googleError}</div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="panel border-line-strong">
            <header className="hairline-b flex h-8 items-center justify-between px-3">
              <span className="label">INITIALIZING WORKSPACE</span>
              <span className="mono-num text-[9px] text-faint">{callsign ?? generated}</span>
            </header>
            <div className="flex flex-col gap-2.5 p-4">
              {BOOT_STEPS.map((s, i) => (
                <div key={s.label} className="flex items-center justify-between">
                  <span className={cx("label", i <= step ? "text-dim" : "text-faint/50")}>{s.label}</span>
                  {i < step ? (
                    <span className="mono-num text-[10px] tracking-[0.12em] text-pos">{s.done}</span>
                  ) : i === step ? (
                    <span className="mono-num animate-blip text-[10px] tracking-[0.12em] text-accent2">LINKING…</span>
                  ) : (
                    <span className="mono-num text-[10px] text-faint/40">STANDBY</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-center gap-4">
          <span className="label-faint">ANONYMOUS</span>
          <span className="size-0.5 bg-faint" />
          <span className="label-faint">NON-CUSTODIAL</span>
          <span className="size-0.5 bg-faint" />
          <span className="label-faint">POLYGON</span>
        </div>
      </div>
    </div>
  );
}
