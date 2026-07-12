import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { fmt, domainKeyFromTitle, type DataTrade, type LeaderboardEntry } from "@sentry-app/polymarket";
import { pal, useTheme } from "../../lib/theme";

/**
 * NETWORK INTELLIGENCE GRAPH.
 * Markets and wallets as nodes; observed capital flow (live tape) as links.
 * Exposes coordinated wallet groups entering related markets.
 */

interface MarketNode extends SimulationNodeDatum {
  id: string;
  kind: "market";
  title: string;
  slug: string;
  usd: number;
  domain: string;
}

interface WalletNode extends SimulationNodeDatum {
  id: string;
  kind: "wallet";
  address: string;
  name: string;
  usd: number;
  smart: boolean;
}

type Node = MarketNode | WalletNode;

interface Link extends SimulationLinkDatum<Node> {
  usd: number;
  side: "BUY" | "SELL";
}

const DOMAIN_COLOR: Record<string, string> = {
  Politics: "#3b7cff",
  Crypto: "#d9a544",
  Macro: "#7fb0d8",
  Sports: "#8a9096",
  Tech: "#9d8cff",
  Other: "#68707a",
};

export function NetworkGraph({
  trades,
  smartWallets,
  height = 560,
  maxMarkets = 24,
  maxWallets = 60,
}: {
  trades: DataTrade[];
  smartWallets: Map<string, LeaderboardEntry>;
  height?: number;
  maxMarkets?: number;
  maxWallets?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ node: Node; x: number; y: number } | null>(null);
  const hoverRef = useRef<Node | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const stateRef = useRef<{ nodes: Node[]; links: Link[] } | null>(null);
  const themeMode = useTheme((s) => s.mode);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const graph = useMemo(() => {
    // aggregate tape into wallet→market flow
    const mAgg = new Map<string, { title: string; slug: string; usd: number }>();
    const wmAgg = new Map<string, { usd: number; side: "BUY" | "SELL"; wallet: string; market: string; name: string }>();
    for (const t of trades) {
      const usd = t.size * t.price;
      if (usd < 50) continue;
      const m = mAgg.get(t.conditionId);
      if (m) m.usd += usd;
      else mAgg.set(t.conditionId, { title: t.title, slug: t.slug, usd });
      const key = `${t.proxyWallet}|${t.conditionId}`;
      const wm = wmAgg.get(key);
      if (wm) wm.usd += t.side === "BUY" ? usd : -usd;
      else
        wmAgg.set(key, {
          usd: t.side === "BUY" ? usd : -usd,
          side: t.side,
          wallet: t.proxyWallet,
          market: t.conditionId,
          name: t.name || t.pseudonym || "",
        });
    }
    const topMarkets = new Set(
      [...mAgg.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, maxMarkets).map(([id]) => id),
    );
    const flows = [...wmAgg.values()]
      .filter((f) => topMarkets.has(f.market) && Math.abs(f.usd) >= 200)
      .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));

    const walletTotals = new Map<string, number>();
    for (const f of flows) walletTotals.set(f.wallet, (walletTotals.get(f.wallet) ?? 0) + Math.abs(f.usd));
    const topWallets = new Set(
      [...walletTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxWallets).map(([w]) => w),
    );

    const nodes: Node[] = [];
    const nodeIndex = new Map<string, Node>();
    for (const [cid, m] of mAgg) {
      if (!topMarkets.has(cid)) continue;
      const n: MarketNode = {
        id: cid,
        kind: "market",
        title: m.title,
        slug: m.slug,
        usd: m.usd,
        domain: domainKeyFromTitle(m.title),
      };
      nodes.push(n);
      nodeIndex.set(cid, n);
    }
    for (const f of flows) {
      if (!topWallets.has(f.wallet) || nodeIndex.has(f.wallet)) continue;
      const n: WalletNode = {
        id: f.wallet,
        kind: "wallet",
        address: f.wallet,
        name: f.name,
        usd: walletTotals.get(f.wallet) ?? 0,
        smart: smartWallets.has(f.wallet.toLowerCase()),
      };
      nodes.push(n);
      nodeIndex.set(f.wallet, n);
    }
    const links: Link[] = flows
      .filter((f) => nodeIndex.has(f.wallet) && nodeIndex.has(f.market))
      .map((f) => ({
        source: f.wallet,
        target: f.market,
        usd: Math.abs(f.usd),
        side: f.usd >= 0 ? "BUY" : "SELL",
      }));
    return { nodes, links };
  }, [trades, smartWallets, maxMarkets, maxWallets]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph.nodes.length) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    const P = pal();

    const nodes = graph.nodes.map((n) => ({ ...n }));
    const links = graph.links.map((l) => ({ ...l }));
    stateRef.current = { nodes, links };

    const maxUsd = Math.max(...nodes.map((n) => n.usd), 1);
    const rOf = (n: Node) =>
      n.kind === "market" ? 5 + Math.sqrt(n.usd / maxUsd) * 16 : 1.5 + Math.sqrt(n.usd / maxUsd) * 7;

    const sim = forceSimulation<Node>(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .id((d) => d.id)
          .distance((l) => 40 + 60 * (1 - Math.min((l as Link).usd / maxUsd, 1)))
          .strength(0.25),
      )
      .force("charge", forceManyBody().strength((d) => ((d as Node).kind === "market" ? -220 : -30)))
      .force("collide", forceCollide<Node>().radius((d) => rOf(d) + 3))
      .force("x", forceX(width / 2).strength(0.045))
      .force("y", forceY(height / 2).strength(0.06))
      .alphaDecay(0.035);

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const hovered = hoverRef.current;
      const connected = new Set<string>();
      if (hovered) {
        connected.add(hovered.id);
        for (const l of links) {
          const s = l.source as Node;
          const t = l.target as Node;
          if (s.id === hovered.id) connected.add(t.id);
          if (t.id === hovered.id) connected.add(s.id);
        }
      }
      // links
      for (const l of links) {
        const s = l.source as Node;
        const t = l.target as Node;
        if (s.x == null || t.x == null) continue;
        const active = hovered && (connected.has(s.id) && connected.has(t.id)) && (s.id === hovered.id || t.id === hovered.id);
        const w = 0.5 + Math.min(l.usd / maxUsd, 1) * 2.5;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.strokeStyle = active
          ? l.side === "BUY"
            ? "rgba(63,174,114,0.75)"
            : "rgba(217,82,75,0.75)"
          : hovered
            ? P.grid
            : l.side === "BUY"
              ? "rgba(63,174,114,0.18)"
              : "rgba(217,82,75,0.18)";
        ctx.lineWidth = w;
        ctx.stroke();
      }
      // nodes
      for (const n of nodes) {
        if (n.x == null) continue;
        const r = rOf(n);
        const dimmed = hovered && !connected.has(n.id);
        if (n.kind === "market") {
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
          const c = DOMAIN_COLOR[n.domain] ?? DOMAIN_COLOR.Other;
          ctx.fillStyle = dimmed ? P.grid : `${c}22`;
          ctx.fill();
          ctx.strokeStyle = dimmed ? P.line : c;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          const s = r * 1.6;
          ctx.fillStyle = dimmed
            ? P.line
            : n.smart
              ? "#3b7cff"
              : "rgba(138,144,150,0.8)";
          ctx.fillRect(n.x! - s / 2, n.y! - s / 2, s, s);
        }
      }
      // labels for the biggest markets
      ctx.font = "500 9.5px 'Inter Tight Variable', sans-serif";
      for (const n of nodes) {
        if (n.kind !== "market" || n.x == null) continue;
        if (n.usd < maxUsd * 0.12 && hovered !== n) continue;
        const dimmed = hovered && !connected.has(n.id);
        if (dimmed) continue;
        ctx.fillStyle = P.dim;
        ctx.fillText(n.title.slice(0, 30), n.x! + rOf(n) + 4, n.y! + 3);
      }
    };

    sim.on("tick", draw);
    drawRef.current = draw;
    draw();
    return () => {
      sim.stop();
      drawRef.current = null;
    };
  }, [graph, width, height, themeMode]);

  const pick = (e: React.MouseEvent): Node | null => {
    const st = stateRef.current;
    if (!st) return null;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: Node | null = null;
    let bestD = Infinity;
    for (const n of st.nodes) {
      if (n.x == null) continue;
      const d = Math.hypot(n.x! - x, n.y! - y);
      const r = n.kind === "market" ? 20 : 9;
      if (d < r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="cursor-crosshair"
        onMouseMove={(e) => {
          const n = pick(e);
          if (hoverRef.current !== n) {
            hoverRef.current = n;
            drawRef.current?.();
          }
          setHover(n ? { node: n, x: e.clientX, y: e.clientY } : null);
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
          drawRef.current?.();
          setHover(null);
        }}
        onClick={(e) => {
          const n = pick(e);
          if (!n) return;
          if (n.kind === "market") navigate(`/market/${n.slug}`);
          else navigate(`/wallet/${n.address.toLowerCase()}`);
        }}
      />
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-3">
        {Object.entries(DOMAIN_COLOR).map(([d, c]) => (
          <span key={d} className="flex items-center gap-1">
            <span className="inline-block size-1.5 rounded-full" style={{ background: c }} />
            <span className="label-faint">{d}</span>
          </span>
        ))}
        <span className="ml-2 flex items-center gap-1">
          <span className="inline-block size-1.5 bg-accent" />
          <span className="label-faint">LEADERBOARD WALLET</span>
        </span>
      </div>
      {hover && (
        <div
          className="pointer-events-none fixed z-40 w-[240px] border border-line-strong bg-raise2 p-2.5"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 260), top: hover.y + 14 }}
        >
          {hover.node.kind === "market" ? (
            <>
              <div className="line-clamp-2 text-[11px] text-text">{hover.node.title}</div>
              <div className="mono-num mt-1 text-[10px] text-faint">
                TAPE FLOW {fmt.usd(hover.node.usd)}
              </div>
            </>
          ) : (
            <>
              <div className="mono-num text-[11px] text-text">
                {hover.node.name || fmt.shortAddr(hover.node.address)}
              </div>
              <div className="mono-num mt-1 flex justify-between text-[10px] text-faint">
                <span>{fmt.usd(hover.node.usd)} MOVED</span>
                {hover.node.smart && <span className="text-accent2">TIER-1</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
