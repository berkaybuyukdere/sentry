import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "dark" | "light";

function apply(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: "dark",
      setMode: (m) => {
        apply(m);
        set({ mode: m });
      },
      toggle: () => get().setMode(get().mode === "dark" ? "light" : "dark"),
    }),
    {
      name: "sentry.theme",
      onRehydrateStorage: () => (state) => apply(state?.mode ?? "dark"),
    },
  ),
);

/** Apply persisted theme before first paint (called from main.tsx). */
export function initTheme() {
  try {
    const raw = localStorage.getItem("sentry.theme");
    const mode = raw ? (JSON.parse(raw).state?.mode as ThemeMode) : "dark";
    apply(mode === "light" ? "light" : "dark");
  } catch {
    apply("dark");
  }
}

/** Resolved canvas palette — charts read live token values so they follow the theme. */
export function pal() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v("--sv-bg"),
    raise2: v("--sv-raise2"),
    raise3: v("--sv-raise3"),
    text: v("--sv-text"),
    dim: v("--sv-dim"),
    faint: v("--sv-faint"),
    line: v("--sv-line"),
    lineStrong: v("--sv-line-strong"),
    grid: v("--sv-grid"),
    accent: v("--sv-accent"),
    accent2: v("--sv-accent2"),
    accentSoft: v("--sv-accent-soft"),
    crosshair: v("--sv-crosshair"),
    pos: v("--sv-pos"),
    neg: v("--sv-neg"),
    warn: v("--sv-warn"),
    hist: v("--sv-hist"),
  };
}
