import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Local order audit trail — record of every order this terminal submitted. */
export interface LoggedOrder {
  id: string; // position id shown to the operator
  ts: number;
  market: string;
  slug: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  shares: number;
  usd: number;
  orderType: string;
  clobOrderId: string | null;
  txHash: string | null;
  status: string;
  error: string | null;
}

interface OrderLogState {
  orders: LoggedOrder[];
  log: (o: Omit<LoggedOrder, "id" | "ts">) => LoggedOrder;
}

export const useOrderLog = create<OrderLogState>()(
  persist(
    (set, get) => ({
      orders: [],
      log: (o) => {
        const seq = get().orders.length + 1;
        const entry: LoggedOrder = {
          ...o,
          id: `84-${String(seq + 1000).padStart(4, "0")}`,
          ts: Date.now(),
        };
        set((s) => ({ orders: [entry, ...s.orders].slice(0, 300) }));
        return entry;
      },
    }),
    { name: "sentry.orders" },
  ),
);
