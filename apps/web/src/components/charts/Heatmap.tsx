import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { useNavigate } from "react-router-dom";
import { pal, useTheme } from "../../lib/theme";
import { fmt, type Market } from "@sentry-app/polymarket";

/**
 * SECTOR HEATMAP — architectural treemap.
 * Cell area = 24h volume · cell tone = 24h probability movement.
 * Grouped by narrative domain. Hairline gaps, restrained color intensity.
 */

interface Cell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  market?: Market;
  group?: string;
}

function toneFor(delta: number, light: boolean): string {
  const mag = Math.min(Math.abs(delta) / 0.12, 1);
  const base = light ? 0.12 : 0.1;
  if (delta > 0.002) return light ? `rgba(29,125,77,${base + mag * 0.4})` : `rgba(63,174,114,${base + mag * 0.45})`;
  if (delta < -0.002) return light ? `rgba(191,58,50,${base + mag * 0.4})` : `rgba(217,82,75,${base + mag * 0.45})`;
  return light ? "rgba(15,23,30,0.05)" : "rgba(255,255,255,0.04)";
}

export function Heatmap({
  markets,
  groupBy,
  height = 520,
}: {
  markets: Market[];
  groupBy: (m: Market) => string;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ market: Market; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(900);
  const navigate = useNavigate();
  const cellsRef = useRef<Cell[]>([]);
  const themeMode = useTheme((s) => s.mode);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const layout = useMemo(() => {
    const groups = new Map<string, Market[]>();
    for (const m of markets) {
      if (m.volume24h < 500) continue;
      const g = groupBy(m);
      const arr = groups.get(g);
      if (arr) arr.push(m);
      else groups.set(g, [m]);
    }
    interface TreeDatum {
      name: string;
      market?: Market;
      value?: number;
      children?: TreeDatum[];
    }
    const rootData: TreeDatum = {
      name: "root",
      children: [...groups.entries()].map(([name, ms]) => ({
        name,
        children: ms.slice(0, 40).map((m) => ({ name: m.question, market: m, value: m.volume24h })),
      })),
    };
    const root = hierarchy<TreeDatum>(rootData)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<TreeDatum>()
      .size([width, height])
      .paddingInner(1)
      .paddingOuter(1)
      .paddingTop(16)
      .tile(treemapSquarify)(root);
  }, [markets, groupBy, width, height]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const P = pal();
    const cells: Cell[] = [];

    for (const node of layout.children ?? []) {
      // group frame + label
      ctx.strokeStyle = P.lineStrong;
      ctx.lineWidth = 1;
      ctx.strokeRect(node.x0 + 0.5, node.y0 + 0.5, node.x1 - node.x0 - 1, node.y1 - node.y0 - 1);
      const gname = node.data.name;
      if (node.x1 - node.x0 > 60) {
        ctx.font = "550 9px 'Inter Tight Variable', sans-serif";
        ctx.fillStyle = P.dim;
        ctx.fillText(gname.toUpperCase(), node.x0 + 5, node.y0 + 11, node.x1 - node.x0 - 10);
      }
      for (const leaf of node.leaves()) {
        const m = leaf.data.market;
        if (!m) continue;
        const w = leaf.x1 - leaf.x0;
        const h = leaf.y1 - leaf.y0;
        if (w < 2 || h < 2) continue;
        ctx.fillStyle = toneFor(m.delta24h, themeMode === "light");
        ctx.fillRect(leaf.x0, leaf.y0, w, h);
        cells.push({ x0: leaf.x0, y0: leaf.y0, x1: leaf.x1, y1: leaf.y1, market: m });
        if (w > 90 && h > 34) {
          ctx.font = "500 10px 'Inter Tight Variable', sans-serif";
          ctx.fillStyle = P.text;
          const title = m.groupItemTitle || m.question;
          ctx.fillText(title.length > w / 6 ? `${title.slice(0, Math.floor(w / 6))}…` : title, leaf.x0 + 5, leaf.y0 + 14, w - 10);
          ctx.font = "500 10px 'JetBrains Mono Variable', monospace";
          ctx.fillStyle = m.delta24h > 0.002 ? P.pos : m.delta24h < -0.002 ? P.neg : P.dim;
          ctx.fillText(`${(m.probability * 100).toFixed(0)}%  ${fmt.pp(m.delta24h)}`, leaf.x0 + 5, leaf.y0 + 27);
        }
      }
    }
    cellsRef.current = cells;
  }, [layout, width, height, themeMode]);

  const pick = (e: React.MouseEvent): Cell | null => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return (
      cellsRef.current.find((c) => x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) ?? null
    );
  };

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <canvas
        ref={ref}
        style={{ width, height }}
        className="cursor-crosshair"
        onMouseMove={(e) => {
          const c = pick(e);
          setHover(c?.market ? { market: c.market, x: e.clientX, y: e.clientY } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const c = pick(e);
          if (c?.market) navigate(`/market/${c.market.slug}`);
        }}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-40 w-[260px] border border-line-strong bg-raise2 p-2.5"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 280), top: hover.y + 14 }}
        >
          <div className="line-clamp-2 text-[11px] text-text">{hover.market.question}</div>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="mono-num text-[13px] text-accent2">{fmt.pct(hover.market.probability)}</span>
            <span className={`mono-num text-[11px] ${hover.market.delta24h >= 0 ? "text-pos" : "text-neg"}`}>
              {fmt.pp(hover.market.delta24h)}pp 24H
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-faint">
            <span>VOL {fmt.usd(hover.market.volume24h)}</span>
            <span>LIQ {fmt.usd(hover.market.liquidity)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
