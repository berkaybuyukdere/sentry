import { useState } from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "../lib/theme";
import {
  useApiAccess,
  testClobCreds,
  testBuilderKey,
  type ImportedClob,
  type BuilderKey,
  type RelayerV2Key,
} from "../lib/apiAccess";
import { Panel, Btn, Tag, cx } from "../components/ui/primitives";

const DATA_ROWS: { label: string; value: string; note?: string }[] = [
  { label: "MARKET METADATA", value: "gamma-api.polymarket.com", note: "REST · 30–90s refresh" },
  { label: "ORDER BOOK / HISTORY", value: "clob.polymarket.com", note: "REST · book 5–8s, series on demand" },
  { label: "LIVE QUOTES", value: "ws-subscriptions-clob.polymarket.com", note: "WebSocket · frame-batched" },
  { label: "TAPE / WALLETS / COHORT", value: "data-api.polymarket.com", note: "REST · tape ≤12s poll" },
  { label: "RELAYER (BUILDER TIER)", value: "relayer-v2.polymarket.com", note: "gasless proxy transactions" },
  { label: "SETTLEMENT", value: "Polygon mainnet · CTF Exchange", note: "0x4bFb…982E / neg-risk 0xC5d5…f80a" },
  { label: "SIGNAL ENGINE", value: "client-side derivation", note: "clusters · whales · anomalies · momentum" },
  { label: "CUSTODY MODEL", value: "non-custodial · anonymous", note: "EIP-712 client signing only" },
];

export function SettingsScreen() {
  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">SYSTEM CONFIGURATION</h1>
      </div>
      <div className="grid max-w-[1080px] grid-cols-2 gap-px bg-line p-px">
        <ThemePanel />
        <Panel className="border-0" title="DATA LINKS — READ-ONLY MANIFEST" pad={false}>
          {DATA_ROWS.map((r) => (
            <div key={r.label} className="hairline-b flex items-center gap-3 px-4 py-2">
              <span className="label w-[176px] shrink-0">{r.label}</span>
              <span className="mono-num min-w-0 flex-1 truncate text-[11px] text-text">{r.value}</span>
              {r.note && <span className="mono-num shrink-0 text-[9px] text-faint">{r.note}</span>}
            </div>
          ))}
        </Panel>
        <ClobCredsPanel />
        <BuilderKeyPanel />
        <RelayerV2Panel />
      </div>
    </div>
  );
}

function ThemePanel() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);
  return (
    <Panel className="border-0" title="OPERATING MODE — DISPLAY">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-px bg-line">
          <button
            onClick={() => setMode("dark")}
            className={cx(
              "focus-outline flex h-16 flex-col items-center justify-center gap-1.5 transition-colors",
              mode === "dark" ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
            )}
          >
            <Moon size={14} strokeWidth={1.5} />
            <span className="label">INTEL DARK</span>
          </button>
          <button
            onClick={() => setMode("light")}
            className={cx(
              "focus-outline flex h-16 flex-col items-center justify-center gap-1.5 transition-colors",
              mode === "light" ? "bg-raise3 text-text" : "bg-raise2 text-faint hover:text-dim",
            )}
          >
            <Sun size={14} strokeWidth={1.5} />
            <span className="label">DAYLIGHT OPS</span>
          </button>
        </div>
        <p className="text-[10px] leading-relaxed text-faint">
          One semantic token set drives both modes — every color keeps its meaning. Charts and
          canvases re-render against the active palette.
        </p>
      </div>
    </Panel>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <div className="label-faint mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder}
        className="focus-outline mono-num h-8 w-full border border-line bg-raise2 px-2.5 text-[11px] text-text placeholder:text-faint"
      />
    </div>
  );
}

function ClobCredsPanel() {
  const stored = useApiAccess((s) => s.clob);
  const setClob = useApiAccess((s) => s.setClob);
  const [form, setForm] = useState<ImportedClob>(
    stored ?? { address: "", apiKey: "", secret: "", passphrase: "" },
  );
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const complete = form.address && form.apiKey && form.secret && form.passphrase;

  const verify = async () => {
    setTesting(true);
    const res = await testClobCreds(form);
    setStatus(res);
    if (res.ok) setClob(form);
    setTesting(false);
  };

  return (
    <Panel className="border-0" title="API ACCESS — CLOB CREDENTIALS (L2)">
      <div className="flex flex-col gap-3">
        <p className="text-[10.5px] leading-relaxed text-dim">
          Import existing CLOB API credentials to unlock authenticated{" "}
          <span className="text-text">reads and cancels without a wallet</span> (open orders, trade
          history). Creating orders always requires a wallet signature — an EIP-712 payload the
          protocol demands from the funds' owner. Credentials are stored in this browser only.
        </p>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="SIGNER ADDRESS" value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="0x…" />
          <Field label="API KEY" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
          <Field label="SECRET" value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} />
          <Field label="PASSPHRASE" value={form.passphrase} onChange={(v) => setForm({ ...form, passphrase: v })} />
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="accent" disabled={!complete || testing} onClick={verify}>
            {testing ? "VERIFYING…" : "TEST & STORE"}
          </Btn>
          {stored && (
            <Btn variant="danger" onClick={() => { setClob(null); setStatus(null); }}>
              PURGE
            </Btn>
          )}
          {stored && !status && <Tag tone="pos">STORED</Tag>}
          {status && <Tag tone={status.ok ? "pos" : "neg"}>{status.ok ? "VERIFIED" : "FAILED"}</Tag>}
        </div>
        {status && <div className={cx("mono-num text-[9.5px]", status.ok ? "text-pos" : "text-neg2")}>{status.detail}</div>}
      </div>
    </Panel>
  );
}

function RelayerV2Panel() {
  const stored = useApiAccess((s) => s.relayerV2);
  const setRelayerV2 = useApiAccess((s) => s.setRelayerV2);
  const [form, setForm] = useState<RelayerV2Key>(stored ?? { key: "", address: "" });
  const complete = form.key.trim().length > 0 && form.address.trim().length > 0;

  return (
    <Panel className="border-0" title="RELAYER API KEY — V2 DEPOSIT WALLET">
      <div className="flex flex-col gap-3">
        <p className="text-[10.5px] leading-relaxed text-dim">
          From the Polymarket portal's <span className="text-text">Relayer API keys</span> tab
          (distinct from the Builders tab above). CLOB v2 needs this to deploy and use your{" "}
          <span className="text-text">Deposit Wallet</span> gaslessly — without it, order placement
          fails with "Deposit Wallet deployment requires a Relayer API Key or Builder API Key".
        </p>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="RELAYER API KEY" value={form.key} onChange={(v) => setForm({ ...form, key: v })} placeholder="019f582d-…" />
          <Field label="RELAYER API KEY ADDRESS" value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="0x1a5b…3505" />
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="accent" disabled={!complete} onClick={() => setRelayerV2(form)}>
            STORE
          </Btn>
          {stored && (
            <Btn variant="danger" onClick={() => { setRelayerV2(null); setForm({ key: "", address: "" }); }}>
              PURGE
            </Btn>
          )}
          {stored && <Tag tone="pos">STORED</Tag>}
        </div>
      </div>
    </Panel>
  );
}

function BuilderKeyPanel() {
  const stored = useApiAccess((s) => s.builder);
  const setBuilder = useApiAccess((s) => s.setBuilder);
  const [form, setForm] = useState<BuilderKey>(
    stored ?? { apiKey: "", secret: "", passphrase: "", builderCode: "", signerAddress: "" },
  );
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const complete = form.apiKey && form.secret && form.passphrase;

  const verify = async () => {
    setTesting(true);
    const res = await testBuilderKey(form);
    setStatus(res);
    if (res.ok) setBuilder(form);
    setTesting(false);
  };

  return (
    <Panel className="border-0" title="API ACCESS — BUILDER KEY (RELAYER)">
      <div className="flex flex-col gap-3">
        <p className="text-[10.5px] leading-relaxed text-dim">
          Keys from Polymarket's developer portal authenticate against the{" "}
          <span className="text-text">relayer</span> (gasless proxy-wallet transactions) and carry a
          builder attribution code. They are a different surface from CLOB trading keys and cannot
          place orders. Reserved here for the relayer tier.
        </p>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="API KEY" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
          <Field label="SECRET" value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} />
          <Field label="PASSPHRASE" value={form.passphrase} onChange={(v) => setForm({ ...form, passphrase: v })} />
          <Field label="SIGNER ADDRESS" value={form.signerAddress} onChange={(v) => setForm({ ...form, signerAddress: v })} placeholder="0x… (portal-issued)" />
          <Field label="BUILDER CODE" value={form.builderCode} onChange={(v) => setForm({ ...form, builderCode: v })} placeholder="0x… attribution code" />
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="accent" disabled={!complete || testing} onClick={verify}>
            {testing ? "VERIFYING…" : "TEST & STORE"}
          </Btn>
          {stored && (
            <Btn variant="danger" onClick={() => { setBuilder(null); setStatus(null); }}>
              PURGE
            </Btn>
          )}
          {stored && !status && <Tag tone="pos">STORED</Tag>}
          {status && <Tag tone={status.ok ? "pos" : "neg"}>{status.ok ? "VERIFIED" : "FAILED"}</Tag>}
        </div>
        {status && <div className={cx("mono-num text-[9.5px]", status.ok ? "text-pos" : "text-neg2")}>{status.detail}</div>}
      </div>
    </Panel>
  );
}
