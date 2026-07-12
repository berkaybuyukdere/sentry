import { create } from "zustand";
import type { Market } from "@sentry-app/polymarket";
import type { ExecOrigin } from "../../lib/billing";

/** Global execution ticket state — any screen can stage an order.
 *  Origin drives the execution rate (MANUAL / SIGNAL / COPY) and, for copy,
 *  carries the source operator for reward attribution. */
interface TicketState {
  open: boolean;
  market: Market | null;
  outcomeIndex: number; // which outcome token
  side: "BUY" | "SELL";
  presetUsd?: number;
  origin: ExecOrigin;
  sourceOperator: { wallet: string; alias: string; rank: number | null } | null;
  /** ARM desk mode: the panel submits the order itself — the only human step
   *  left is the wallet signature (protocol-required, non-custodial) */
  auto: boolean;
  stage: (
    market: Market,
    outcomeIndex: number,
    side?: "BUY" | "SELL",
    presetUsd?: number,
    origin?: ExecOrigin,
    sourceOperator?: { wallet: string; alias: string; rank: number | null } | null,
    auto?: boolean,
  ) => void;
  close: () => void;
}

export const useTicket = create<TicketState>((set) => ({
  open: false,
  market: null,
  outcomeIndex: 0,
  side: "BUY",
  presetUsd: undefined,
  origin: "MANUAL",
  sourceOperator: null,
  auto: false,
  stage: (market, outcomeIndex, side = "BUY", presetUsd, origin = "MANUAL", sourceOperator = null, auto = false) =>
    set({ open: true, market, outcomeIndex, side, presetUsd, origin, sourceOperator, auto }),
  close: () => set({ open: false, auto: false }),
}));
