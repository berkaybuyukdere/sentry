import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  AreaSeries,
  HistogramSeries,
  createSeriesMarkers,
  ColorType,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import type { PricePoint, DataTrade } from "@sentry-app/polymarket";
import { pal, useTheme } from "../../lib/theme";

/**
 * Institutional probability chart.
 * Area = probability of the primary outcome. Optional volume histogram.
 * Tape events (large fills) are annotated directly on the timeline so
 * information and market movement stay visually connected.
 */
export function ProbabilityChart({
  history,
  tapeMarks = [],
  height = 320,
}: {
  history: PricePoint[];
  tapeMarks?: DataTrade[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const themeMode = useTheme((s) => s.mode);

  const data = useMemo(
    () =>
      [...history]
        .sort((a, b) => a.t - b.t)
        .filter((p, i, arr) => i === 0 || p.t !== arr[i - 1].t)
        .map((p) => ({ time: p.t as UTCTimestamp, value: p.p * 100 })),
    [history],
  );

  const markers = useMemo<SeriesMarker<UTCTimestamp>[]>(() => {
    if (!data.length) return [];
    const t0 = data[0].time as number;
    const t1 = data[data.length - 1].time as number;
    return tapeMarks
      .filter((t) => t.timestamp >= t0 && t.timestamp <= t1 && t.size * t.price >= 2000)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-24)
      .map((t) => ({
        time: t.timestamp as UTCTimestamp,
        position: t.side === "BUY" ? "belowBar" : "aboveBar",
        color: t.side === "BUY" ? "#3fae72" : "#d9524b",
        shape: t.side === "BUY" ? "arrowUp" : "arrowDown",
        size: 0.7,
        text: `$${Math.round((t.size * t.price) / 1000)}K`,
      }));
  }, [tapeMarks, data]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const P = pal();
    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: P.faint,
        fontFamily: "'JetBrains Mono Variable', monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: P.grid },
        horzLines: { color: P.grid },
      },
      rightPriceScale: {
        borderColor: P.line,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: P.line,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: P.crosshair, width: 1, style: LineStyle.Solid, labelBackgroundColor: P.raise3 },
        horzLine: { color: P.crosshair, width: 1, style: LineStyle.Solid, labelBackgroundColor: P.raise3 },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    const area = chart.addSeries(AreaSeries, {
      lineColor: P.accent,
      lineWidth: 1,
      topColor: P.accentSoft,
      bottomColor: "rgba(0,0,0,0)",
      priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.1 },
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: P.crosshair,
      priceLineStyle: LineStyle.Dotted,
    });
    area.setData(data);

    if (markers.length) createSeriesMarkers(area, markers);

    // volume-by-interval histogram derived from tape marks (real fills only)
    if (tapeMarks.length && data.length > 4) {
      const vol = chart.addSeries(HistogramSeries, {
        priceScaleId: "vol",
        color: P.hist,
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      const bucketSec = Math.max(60, Math.floor(((data[data.length - 1].time as number) - (data[0].time as number)) / 120));
      const buckets = new Map<number, number>();
      for (const t of tapeMarks) {
        const b = Math.floor(t.timestamp / bucketSec) * bucketSec;
        buckets.set(b, (buckets.get(b) ?? 0) + t.size * t.price);
      }
      vol.setData(
        [...buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time: time as UTCTimestamp, value })),
      );
    }

    chart.timeScale().fitContent();

    const obs = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
      chart.timeScale().fitContent();
    });
    obs.observe(el);
    return () => {
      obs.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, markers, tapeMarks, height, themeMode]);

  return <div ref={ref} className="w-full" style={{ height }} />;
}
