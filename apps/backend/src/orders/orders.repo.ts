import { pool } from "../db/pool.js";
import { canTransition, type Order, type OrderState } from "./order.types.js";

interface OrderRow {
  id: string;
  order_number: number;
  merchant_chat_id: string | null;
  item_name: string;
  quantity: number;
  amount_etb: string; // numeric comes back as string from pg
  courier_eta_min: number | null;
  state: OrderState;
  created_at: Date;
  updated_at: Date;
}

function toOrder(r: OrderRow): Order {
  return {
    id: r.id,
    orderNumber: r.order_number,
    merchantChatId: r.merchant_chat_id,
    itemName: r.item_name,
    quantity: r.quantity,
    amountEtb: Number(r.amount_etb),
    courierEtaMin: r.courier_eta_min,
    state: r.state,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface NewOrder {
  orderNumber: number;
  merchantChatId?: string | null;
  itemName: string;
  quantity: number;
  amountEtb: number;
  courierEtaMin?: number | null;
}

/** Upsert by order_number so re-running the seed script is safe. */
export async function upsertOrder(input: NewOrder): Promise<Order> {
  const { rows } = await pool.query<OrderRow>(
    `INSERT INTO orders (order_number, merchant_chat_id, item_name, quantity, amount_etb, courier_eta_min)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (order_number) DO UPDATE
       SET merchant_chat_id = EXCLUDED.merchant_chat_id,
           item_name        = EXCLUDED.item_name,
           quantity         = EXCLUDED.quantity,
           amount_etb       = EXCLUDED.amount_etb,
           courier_eta_min  = EXCLUDED.courier_eta_min,
           state            = 'PENDING',
           updated_at       = now()
     RETURNING *`,
    [
      input.orderNumber,
      input.merchantChatId ?? null,
      input.itemName,
      input.quantity,
      input.amountEtb,
      input.courierEtaMin ?? null,
    ],
  );
  return toOrder(rows[0]!);
}

export async function getByNumber(orderNumber: number): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT * FROM orders WHERE order_number = $1`,
    [orderNumber],
  );
  return rows[0] ? toOrder(rows[0]) : null;
}

export class InvalidTransitionError extends Error {
  constructor(from: OrderState, to: OrderState) {
    super(`Illegal order transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Transition an order's state atomically. We re-read the current state inside the
 * same statement's WHERE guard so two concurrent confirms can't both "win" — the
 * second simply updates nothing and we report the current state. This is what
 * makes the 1-tap merchant confirm safe even if Telegram delivers the callback
 * twice (which it can, on flaky networks).
 */
export async function transition(orderNumber: number, to: OrderState): Promise<Order> {
  const current = await getByNumber(orderNumber);
  if (!current) throw new Error(`Order #${orderNumber} not found`);
  if (current.state === to) return current; // idempotent: already there
  if (!canTransition(current.state, to)) {
    throw new InvalidTransitionError(current.state, to);
  }
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET state = $2, updated_at = now()
     WHERE order_number = $1 AND state = $3
     RETURNING *`,
    [orderNumber, to, current.state],
  );
  // If the guarded UPDATE matched nothing, another request transitioned first —
  // return the latest truth rather than throwing.
  return rows[0] ? toOrder(rows[0]) : (await getByNumber(orderNumber))!;
}
