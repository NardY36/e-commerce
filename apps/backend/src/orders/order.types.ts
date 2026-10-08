/**
 * Order lifecycle. Keeping the allowed transitions in one table (rather than
 * scattered `if` checks) means an invalid jump — e.g. confirming an order that is
 * already PICKED_UP — fails loudly in one place and is trivial to reason about.
 */
export const ORDER_STATES = [
  "PENDING",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  PENDING: ["READY_FOR_PICKUP", "CANCELLED"],
  READY_FOR_PICKUP: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Order {
  id: string;
  orderNumber: number;
  merchantChatId: string | null;
  itemName: string;
  quantity: number;
  amountEtb: number;
  courierEtaMin: number | null;
  state: OrderState;
  createdAt: string;
  updatedAt: string;
}
