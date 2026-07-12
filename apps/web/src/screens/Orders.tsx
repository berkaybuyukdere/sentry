import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useWalletClient } from "wagmi";
import { fmt } from "@sentry-app/polymarket";
import { useOrderLog } from "../lib/trading/orderLog";
import { fetchOpenOrdersWithCreds, cancelOrderWithCreds } from "../lib/trading/orders";
import { ensureCreds, cachedCreds } from "../lib/trading/clobAuth";
import { useApiAccess } from "../lib/apiAccess";
import type { OpenOrder } from "../lib/trading/orders";
import { Panel, Btn, Tag, Empty, cx } from "../components/ui/primitives";
import { TxLink } from "../components/ui/ExtLink";

/** Orders — local execution audit trail + live CLOB open-order management. */
export function OrdersScreen() {
  const orders = useOrderLog((s) => s.orders);
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [open, setOpen] = useState<OpenOrder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const imported = useApiAccess((s) => s.clob);

  /** wallet-derived creds when linked; otherwise imported API credentials */
  const resolveAccess = async (): Promise<{ addr: string; creds: NonNullable<ReturnType<typeof cachedCreds>> } | null> => {
    if (address) {
      const cached = cachedCreds(address);
      if (cached) return { addr: address, creds: cached };
      if (walletClient) return { addr: address, creds: await ensureCreds(walletClient, address) };
    }
    if (imported) {
      const { address: a, ...creds } = imported;
      return { addr: a, creds };
    }
    return null;
  };

  const loadOpen = async () => {
    setLoading(true);
    setErr(null);
    try {
      const access = await resolveAccess();
      if (!access) throw new Error("No wallet linked and no CLOB credentials imported (Settings → API ACCESS)");
      setOpen(await fetchOpenOrdersWithCreds(access.addr, access.creds));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      const access = await resolveAccess();
      if (!access) return;
      await cancelOrderWithCreds(access.addr, access.creds, id);
      await loadOpen();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "cancel failed");
    }
  };

  const hasAccess = !!address || !!imported;

  return (
    <div className="flex flex-col">
      <div className="hairline-b flex h-11 items-center gap-3 px-4">
        <h1 className="text-[13px] font-semibold tracking-[0.16em] text-text">ORDERS</h1>
        <span className="mono-num text-[10px] text-faint">{orders.length} LOGGED THIS TERMINAL</span>
      </div>

      <div className="grid grid-cols-3 gap-px bg-line p-px">
        <Panel className="col-span-2 border-0" title="EXECUTION AUDIT TRAIL" pad={false}>
          {!orders.length ? (
            <Empty label="NO ORDERS SUBMITTED" hint="Executed orders are recorded here with their CLOB status." />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="hairline-b">
                  <th className="label-faint px-3 py-1.5 text-left font-medium">POSITION ID</th>
                  <th className="label-faint px-2 py-1.5 text-left font-medium">MARKET</th>
                  <th className="label-faint px-2 py-1.5 text-left font-medium">SIDE</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">PRICE</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">SHARES</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">NOTIONAL</th>
                  <th className="label-faint px-2 py-1.5 text-left font-medium">TYPE</th>
                  <th className="label-faint px-2 py-1.5 text-left font-medium">STATUS</th>
                  <th className="label-faint px-2 py-1.5 text-right font-medium">TIME</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="hairline-b h-9 row-hover">
                    <td className="mono-num px-3 text-[10.5px] text-accent2">{o.id}</td>
                    <td className="max-w-0 truncate px-2 text-[11px] text-text">
                      <Link to={`/market/${o.slug}`} className="hover:text-accent2">{o.market}</Link>
                    </td>
                    <td className={cx("px-2 text-[10px] font-semibold", o.side === "BUY" ? "text-pos" : "text-neg")}>
                      {o.side} {o.outcome.toUpperCase()}
                    </td>
                    <td className="mono-num px-2 text-right text-[10.5px] text-dim">{(o.price * 100).toFixed(1)}¢</td>
                    <td className="mono-num px-2 text-right text-[10.5px] text-dim">{fmt.num(o.shares, 2)}</td>
                    <td className="mono-num px-2 text-right text-[11px] text-text">{fmt.usd(o.usd, { compact: false })}</td>
                    <td className="mono-num px-2 text-[10px] text-faint">{o.orderType}</td>
                    <td className="px-2">
                      <Tag tone={o.error ? "neg" : o.status === "matched" ? "pos" : "accent"}>
                        {(o.error ? "REJECTED" : o.status).toUpperCase()}
                      </Tag>
                    </td>
                    <td className="mono-num px-2 text-right text-[9.5px] text-faint">
                      <span className="inline-flex items-center gap-1.5">
                        {o.txHash && <TxLink hash={o.txHash} />}
                        {new Date(o.ts).toISOString().slice(5, 16).replace("T", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          className="border-0"
          title="OPEN ORDERS — CLOB"
          pad={false}
          right={
            <Btn size="sm" variant="ghost" onClick={loadOpen} disabled={!hasAccess || loading}>
              {loading ? "QUERYING…" : "REFRESH"}
            </Btn>
          }
        >
          {!hasAccess ? (
            <Empty label="NO ACCESS CHANNEL" hint="Link a wallet or import CLOB credentials in Settings." />
          ) : open === null ? (
            <Empty label="NOT QUERIED" hint="REFRESH performs an authenticated CLOB read." />
          ) : !open.length ? (
            <Empty label="NO RESTING ORDERS" />
          ) : (
            <div className="flex flex-col">
              {open.map((o) => (
                <div key={o.id} className="hairline-b flex items-center gap-2 px-3 py-2">
                  <span className={cx("text-[10px] font-semibold", o.side === "BUY" ? "text-pos" : "text-neg")}>
                    {o.side}
                  </span>
                  <span className="mono-num min-w-0 flex-1 truncate text-[10px] text-dim">{o.id}</span>
                  <span className="mono-num text-[10.5px] text-text">{(Number(o.price) * 100).toFixed(1)}¢</span>
                  <span className="mono-num text-[10px] text-faint">
                    {o.size_matched}/{o.original_size}
                  </span>
                  <Btn size="sm" variant="danger" onClick={() => cancel(o.id)}>
                    CANCEL
                  </Btn>
                </div>
              ))}
            </div>
          )}
          {err && (
            <div className="border border-neg/40 bg-neg/5 px-2.5 py-1.5 text-[10px] text-neg2">
              {err}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
