import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { polygon } from "wagmi/chains";
import { X, Plug, Unplug, ArrowUpRight } from "lucide-react";
import { fmt } from "@sentry-app/polymarket";
import { Btn, StatusDot, Tag, cx } from "../ui/primitives";

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const [open, setOpen] = useState(false);
  const wrongChain = isConnected && chainId !== polygon.id;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cx(
          "focus-outline flex h-7 items-center gap-2 border px-2.5 text-[10px] uppercase tracking-[0.1em] transition-colors",
          isConnected
            ? wrongChain
              ? "border-warn/60 text-warn2"
              : "border-line bg-raise text-dim hover:border-line-strong hover:text-text"
            : "border-accent/60 bg-accent/10 text-accent2 hover:bg-accent/20",
        )}
      >
        <StatusDot tone={isConnected ? (wrongChain ? "warn" : "pos") : "dim"} pulse={isConnected && !wrongChain} />
        {isConnected ? (wrongChain ? "WRONG NETWORK" : fmt.shortAddr(address!)) : "CONNECT WALLET"}
      </button>
      {open && <WalletModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** Detected wallets (EIP-6963 announced) surface with their own icons;
 *  fallback connectors cover MetaMask/Coinbase installs + WalletConnect. */
export function WalletModal({ onClose }: { onClose: () => void }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const wrongChain = isConnected && chainId !== polygon.id;

  const list = useMemo(() => {
    // 6963-discovered connectors carry `icon`; drop the generic "Injected"
    // entry and fallback duplicates of already-discovered wallets.
    const discovered = connectors.filter((c) => c.icon);
    const discoveredNames = new Set(discovered.map((c) => c.name.toLowerCase()));
    const fallbacks = connectors.filter(
      (c) => !c.icon && c.id !== "injected" && !discoveredNames.has(c.name.toLowerCase()),
    );
    return [...discovered, ...fallbacks];
  }, [connectors]);

  const phantomDetected = list.some((c) => c.name.toLowerCase().includes("phantom"));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="panel w-[400px] border-line-strong" onClick={(e) => e.stopPropagation()}>
        <header className="hairline-b flex h-9 items-center justify-between px-3">
          <span className="label">WALLET LINK</span>
          <button onClick={onClose} className="focus-outline text-faint hover:text-text">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-relaxed text-dim">
            Non-custodial and anonymous. SENTRY never holds funds or keys — every order and
            transfer is signed by your own wallet and settled on Polygon. No account is created.
          </p>

          {!isConnected ? (
            <div className="flex flex-col gap-1.5">
              {list.map((c: Connector) => (
                <button
                  key={c.uid}
                  disabled={isPending}
                  onClick={() => connect({ connector: c })}
                  className="focus-outline flex h-9 items-center gap-2.5 border border-line bg-raise2 px-3 text-[11px] uppercase tracking-[0.08em] text-text transition-colors hover:border-accent/60 hover:bg-raise3 disabled:opacity-40"
                >
                  {c.icon ? (
                    <img src={c.icon} alt="" className="size-4" />
                  ) : (
                    <Plug size={12} strokeWidth={1.5} className="text-accent2" />
                  )}
                  <span className="flex-1 text-left">{c.name}</span>
                  {c.icon && <Tag tone="pos">DETECTED</Tag>}
                </button>
              ))}
              {!phantomDetected && (
                <a
                  href="https://phantom.com/download"
                  target="_blank"
                  rel="noreferrer"
                  className="focus-outline flex h-9 items-center gap-2.5 border border-line bg-raise px-3 text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:border-line-strong hover:text-dim"
                >
                  <Plug size={12} strokeWidth={1.5} />
                  <span className="flex-1 text-left">PHANTOM</span>
                  <span className="label-faint flex items-center gap-1">
                    INSTALL <ArrowUpRight size={10} strokeWidth={1.5} />
                  </span>
                </a>
              )}
              {error && (
                <div className="border border-warn/40 bg-warn/5 px-2.5 py-1.5 text-[10px] text-warn2">
                  {error.message.split("\n")[0]}
                </div>
              )}
              <p className="text-[9.5px] leading-relaxed text-faint">
                Any EIP-6963 wallet is detected automatically — Phantom, MetaMask, Rabby, OKX,
                Backpack, Zerion and others appear here once installed.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="border border-line bg-raise2 px-3 py-2.5">
                <div className="label-faint mb-1">LINKED IDENTITY</div>
                <div className="mono-num text-[12px] text-text">{address}</div>
                <div className="mt-1 flex items-center gap-2">
                  <StatusDot tone={wrongChain ? "warn" : "pos"} />
                  <span className="text-[10px] uppercase tracking-[0.1em] text-dim">
                    {connector?.name} · {wrongChain ? `CHAIN ${chainId}` : "POLYGON"}
                  </span>
                </div>
              </div>
              {wrongChain && (
                <Btn variant="accent" size="lg" onClick={() => switchChain({ chainId: polygon.id })}>
                  SWITCH TO POLYGON
                </Btn>
              )}
              <Btn variant="danger" onClick={() => disconnect()}>
                <Unplug size={11} strokeWidth={1.5} /> SEVER LINK
              </Btn>
            </div>
          )}

          <div className="hairline-t flex items-center justify-between pt-2">
            <span className="label-faint">ANONYMOUS SESSION</span>
            <span className="label-faint">CLIENT-SIDE SIGNING ONLY</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
