import { memo, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { fmt } from "@sentry-app/polymarket";
import { pal, useTheme } from "../../lib/theme";

/* ============================================================================
   SENTRY primitives — every screen is assembled from these.
   Sharp geometry, hairline structure, meaningful color only.
   ========================================================================== */

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// --- Panel: a region of the operating surface, never a floating card -------

export function Panel({
  title,
  right,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={cx("panel flex min-h-0 flex-col", className)}>
      {(title || right) && (
        <header className="hairline-b flex h-8 shrink-0 items-center justify-between gap-2 px-3">
          <div className="label truncate">{title}</div>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={cx("min-h-0 flex-1", pad && "p-3")}>{children}</div>
    </section>
  );
}

// --- Buttons ----------------------------------------------------------------

type BtnVariant = "default" | "accent" | "yes" | "no" | "ghost" | "danger";

const btnStyles: Record<BtnVariant, string> = {
  default:
    "border border-line-strong bg-raise2 text-text hover:border-line-hover hover:bg-raise3",
  accent: "border border-accent/60 bg-accent/15 text-accent2 hover:bg-accent/25 hover:border-accent",
  yes: "border border-pos/50 bg-pos/10 text-pos2 hover:bg-pos/20 hover:border-pos/80",
  no: "border border-neg/50 bg-neg/10 text-neg2 hover:bg-neg/20 hover:border-neg/80",
  ghost: "border border-transparent text-dim hover:text-text hover:border-line-strong",
  danger: "border border-neg/50 bg-transparent text-neg2 hover:bg-neg/15",
};

export function Btn({
  variant = "default",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...props}
      className={cx(
        "focus-outline inline-flex select-none items-center justify-center gap-1.5 font-medium uppercase tracking-[0.08em] transition-colors duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-6 px-2 text-[10px]",
        size === "md" && "h-7 px-3 text-[11px]",
        size === "lg" && "h-9 px-4 text-[12px]",
        btnStyles[variant],
        className,
      )}
    />
  );
}

// --- Status + tags -----------------------------------------------------------

export function StatusDot({
  tone = "accent",
  pulse = false,
}: {
  tone?: "accent" | "pos" | "neg" | "warn" | "dim";
  pulse?: boolean;
}) {
  const color = {
    accent: "bg-accent",
    pos: "bg-pos",
    neg: "bg-neg",
    warn: "bg-warn",
    dim: "bg-faint",
  }[tone];
  return <span className={cx("inline-block size-1.5", color, pulse && "animate-blip")} />;
}

export function Tag({
  children,
  tone = "dim",
  className,
}: {
  children: ReactNode;
  tone?: "dim" | "accent" | "pos" | "neg" | "warn";
  className?: string;
}) {
  const styles = {
    dim: "border-line-strong text-dim",
    accent: "border-accent/50 text-accent2",
    pos: "border-pos/50 text-pos2",
    neg: "border-neg/50 text-neg2",
    warn: "border-warn/50 text-warn2",
  }[tone];
  return (
    <span
      className={cx(
        "inline-flex h-[17px] shrink-0 items-center whitespace-nowrap border px-1.5 text-[9px] font-medium uppercase tracking-[0.1em]",
        styles,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function severityTone(s: string): "dim" | "accent" | "warn" | "neg" {
  if (s === "CRITICAL") return "neg";
  if (s === "HIGH") return "warn";
  if (s === "ELEVATED") return "accent";
  return "dim";
}

// --- Data values --------------------------------------------------------------

/** Signed percentage-point delta with system colors. */
export function Delta({ value, digits = 1, suffix = "" }: { value: number; digits?: number; suffix?: string }) {
  const v = value * 100;
  const cls = v > 0.05 ? "text-pos" : v < -0.05 ? "text-neg" : "text-faint";
  return (
    <span className={cx("mono-num", cls)}>
      {v > 0 ? "+" : ""}
      {v.toFixed(digits)}
      {suffix}
    </span>
  );
}

/** Live number that flashes luminance on change direction. */
export const LiveNum = memo(function LiveNum({
  value,
  format,
  className,
}: {
  value: number;
  format: (v: number) => string;
  className?: string;
}) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (value !== prev.current) {
      setFlash(value > prev.current ? "up" : "down");
      prev.current = value;
      const t = setTimeout(() => setFlash(null), 800);
      return () => clearTimeout(t);
    }
  }, [value]);
  return (
    <span
      key={flash ? `${flash}-${value}` : "static"}
      className={cx("mono-num", flash === "up" && "val-flash-up", flash === "down" && "val-flash-down", className)}
    >
      {format(value)}
    </span>
  );
});

/** Horizontal probability bar — the terminal's core market glyph. */
export function ProbBar({ p, className }: { p: number; className?: string }) {
  return (
    <div className={cx("h-[3px] w-full bg-raise3", className)}>
      <div className="h-full bg-accent/80" style={{ width: `${Math.min(100, Math.max(0, p * 100))}%` }} />
    </div>
  );
}

// --- Canvas sparkline ----------------------------------------------------------

export const Spark = memo(function Spark({
  points,
  width = 96,
  height = 24,
  tone,
}: {
  points: number[];
  width?: number;
  height?: number;
  tone?: "pos" | "neg" | "accent" | "auto";
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const themeMode = useTheme((s) => s.mode);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || points.length < 2) return;
    const P = pal();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const stepX = width / (points.length - 1);
    const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
    const resolved =
      tone === "auto" || !tone
        ? points[points.length - 1] >= points[0]
          ? P.pos
          : P.neg
        : { pos: P.pos, neg: P.neg, accent: P.accent }[tone];
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(0, y(p)) : ctx.lineTo(i * stepX, y(p))));
    ctx.strokeStyle = resolved;
    ctx.lineWidth = 1;
    ctx.stroke();
    // terminal dot
    ctx.fillStyle = resolved;
    ctx.fillRect(width - 2, y(points[points.length - 1]) - 1, 2, 2);
  }, [points, width, height, tone, themeMode]);
  return <canvas ref={ref} style={{ width, height }} />;
});

// --- Loading / empty states -----------------------------------------------------

export function Loading({ label = "RETRIEVING", className }: { label?: string; className?: string }) {
  return (
    <div className={cx("scanline flex h-24 items-center justify-center", className)}>
      <span className="label-faint">{label}</span>
    </div>
  );
}

export function Empty({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-1.5">
      <div className="size-1.5 bg-faint" />
      <div className="label-faint">{label}</div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-24 flex-col items-center justify-center gap-1">
      <div className="label text-warn">RETRIEVAL FAULT</div>
      <div className="max-w-[80%] truncate text-[11px] text-faint">{message}</div>
    </div>
  );
}

// --- Metric block -----------------------------------------------------------------

export function Metric({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "warn" | "accent";
  className?: string;
}) {
  const toneCls = tone
    ? { pos: "text-pos", neg: "text-neg", warn: "text-warn", accent: "text-accent2" }[tone]
    : "text-text";
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <div className="label-faint">{label}</div>
      <div className={cx("mono-num text-[17px] leading-none", toneCls)}>{value}</div>
      {sub !== undefined && <div className="text-[10px] leading-tight text-faint">{sub}</div>}
    </div>
  );
}

// --- Address rendering ---------------------------------------------------------------

export function Addr({ address, name }: { address: string; name?: string | null }) {
  return (
    <span className="mono-num text-[11px]">
      {name ? (
        <>
          <span className="text-text">{name}</span>{" "}
          <span className="text-faint">{fmt.shortAddr(address)}</span>
        </>
      ) : (
        <span className="text-text">{fmt.shortAddr(address)}</span>
      )}
    </span>
  );
}
