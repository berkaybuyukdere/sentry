import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AccessMethod = "ANONYMOUS" | "WALLET" | "GOOGLE";

/** Local operator workspace session — anonymous by design.
 *  Every method resolves to a local callsign; no PII is ever persisted
 *  (Google entry derives the callsign from a one-way hash and discards
 *  the identity token). Wallet connection is the trading identity. */
interface SessionState {
  callsign: string | null;
  method: AccessMethod | null;
  authedAt: number | null;
  booted: boolean; // initialization sequence completed this page load
  authenticate: (callsign: string, method?: AccessMethod) => void;
  setBooted: () => void;
  terminate: () => void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      callsign: null,
      method: null,
      authedAt: null,
      booted: false,
      authenticate: (callsign, method = "ANONYMOUS") =>
        set({ callsign, method, authedAt: Date.now() }),
      setBooted: () => set({ booted: true }),
      terminate: () => set({ callsign: null, method: null, authedAt: null, booted: false }),
    }),
    {
      name: "sentry.session",
      partialize: (s) => ({ callsign: s.callsign, method: s.method, authedAt: s.authedAt }),
    },
  ),
);
