import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { pal, useTheme } from "../../lib/theme";
import { fmt, type Market } from "@sentry-app/polymarket";

/**
 * VELOCITY MATRIX — market positioning field.
 * X: volume velocity (24h volume / open liquidity, log scale)
 * Y: 24h probability movement (pp)
 * Area: open liquidity. The upper-right field = fast capital + rising probability.
 */

interface Pt {
  x: number;
  y: number;
  r: number;
  m: Market;
}

export function MatrixPlot({ markets, height = 520 }: { markets: Market[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ m: Market; x: number; y: number } | null>(null);
  const ptsRef = useRef<Pt[]>([]);
  const navigate = useNavigate();
  const themeMode = useTheme((s) => s.mode);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

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

    const pad = { l: 46, r: 16, t: 16, b: 30 };
    const iw = width - pad.l - pad.r;
    const ih = height - pad.t - pad.b;

    const rows = markets.filter((m) => m.volume24h > 1000 && m.liquidity > 200);
    const vel = (m: Market) => Math.log10(Math.max(0.01, m.volume24h / Math.max(m.liquidity, 1)));
    const velVals = rows.map(vel);
    const vMin = Math.min(...velVals, -1);
    const vMax = Math.max(...velVals, 1);
    const dMax = Math.max(...rows.map((m) => Math.abs(m.delta24h)), 0.05);
    const liqMax = Math.max(...rows.map((m) => m.liquidity), 1);

    const X = (m: Market) => pad.l + ((vel(m) - vMin) / (vMax - vMin)) * iw;
    const Y = (m: Market) => pad.t + ih / 2 - (m.delta24h / dMax) * (ih / 2) * 0.92;
    const R = (m: Market) => 2.5 + Math.sqrt(m.liquidity / liqMax) * 22;

    // frame + gridlines
    ctx.strokeStyle = P.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, iw - 1, ih - 1);
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + ih / 2 + 0.5);
    ctx.lineTo(pad.l + iw, pad.t + ih / 2 + 0.5);
    ctx.strokeStyle = P.lineStrong;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "500 9px 'Inter Tight Variable', sans-serif";
    ctx.fillStyle = P.faint;
    ctx.fillText("VOLUME VELOCITY →", pad.l, height - 10);
    ctx.save();
    ctx.translate(12, pad.t + ih / 2 + 46);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Δ PROBABILITY 24H →", 0, 0);
    ctx.restore();
    ctx.fillText(`+${(dMax * 100).toFixed(0)}pp`, 8, pad.t + 10);
    ctx.fillText(`-${(dMax * 100).toFixed(0)}pp`, 8, pad.t + ih);

    const pts: Pt[] = [];
    for (const m of rows) {
      const x = X(m);
      const y = Y(m);
      const r = R(m);
      const rising = m.delta24h >= 0;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rising ? "rgba(63,174,114,0.14)" : "rgba(217,82,75,0.14)";
      ctx.fill();
      ctx.strokeStyle = rising ? "rgba(63,174,114,0.7)" : "rgba(217,82,75,0.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
      pts.push({ x, y, r, m });
    }
    // label the strongest movers
    const labeled = [...rows]
      .sort((a, b) => Math.abs(b.delta24h) * b.volume24h - Math.abs(a.delta24h) * a.volume24h)
      .slice(0, 7);
    ctx.font = "500 9.5px 'Inter Tight Variable', sans-serif";
    for (const m of labeled) {
      const t = (m.groupItemTitle || m.question).slice(0, 26);
      ctx.fillStyle = P.dim;
      ctx.fillText(t, X(m) + R(m) + 4, Y(m) + 3);
    }
    ptsRef.current = pts;
  }, [markets, width, height, themeMode]);

  const pick = (e: React.MouseEvent): Pt | null => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: Pt | null = null;
    let bestD = Infinity;
    for (const p of ptsRef.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < p.r + 4 && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <canvas
        ref={ref}
        style={{ width, height }}
        className="cursor-crosshair"
        onMouseMove={(e) => {
          const p = pick(e);
          setHover(p ? { m: p.m, x: e.clientX, y: e.clientY } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const p = pick(e);
          if (p) navigate(`/market/${p.m.slug}`);
        }}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-40 w-[250px] border border-line-strong bg-raise2 p-2.5"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 270), top: hover.y + 14 }}
        >
          <div className="line-clamp-2 text-[11px] text-text">{hover.m.question}</div>
          <div className="mono-num mt-1 flex justify-between text-[10px] text-dim">
            <span>{fmt.pct(hover.m.probability)}</span>
            <span className={hover.m.delta24h >= 0 ? "text-pos" : "text-neg"}>{fmt.pp(hover.m.delta24h)}pp</span>
            <span>V/L {(hover.m.volume24h / Math.max(hover.m.liquidity, 1)).toFixed(1)}×</span>
          </div>
        </div>
      )}
    </div>
  );
}
