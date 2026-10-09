import { pool } from "../db/pool.js";

export type PaymentStatus =
  | "PENDING"
  | "PROCESSING"
  | "PENDING_VERIFY"
  | "SUCCESS"
  | "FAILED";

export interface Payment {
  id: string;
  idempotencyKey: string;
  orderId: string | null;
  amountEtb: number;
  customerPhone: string;
  status: PaymentStatus;
  telebirrRef: string | null;
  attempts: number;
  lastError: string | null;
}

interface PaymentRow {
  id: string;
  idempotency_key: string;
  order_id: string | null;
  amount_etb: string;
  customer_phone: string;
  status: PaymentStatus;
  telebirr_ref: string | null;
  attempts: number;
  last_error: string | null;
}

const toPayment = (r: PaymentRow): Payment => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  orderId: r.order_id,
  amountEtb: Number(r.amount_etb),
  customerPhone: r.customer_phone,
  status: r.status,
  telebirrRef: r.telebirr_ref,
  attempts: r.attempts,
  lastError: r.last_error,
});

export interface NewPaymentIntent {
  idempotencyKey: string;
  orderId?: string | null;
  amountEtb: number;
  customerPhone: string;
}

/**
 * The idempotency gate. `ON CONFLICT (idempotency_key) DO NOTHING` means a
 * duplicate request — a double-tapped "Pay" button, a client retry after its own
 * timeout — can NEVER insert a second payment row. We report whether this call
 * created the intent or merely found the existing one, so the caller only enqueues
 * work the first time.
 */
export async function createOrGetIntent(
  input: NewPaymentIntent,
): Promise<{ payment: Payment; created: boolean }> {
  const inserted = await pool.query<PaymentRow>(
    `INSERT INTO payments (idempotency_key, order_id, amount_etb, customer_phone, status)
     VALUES ($1,$2,$3,$4,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [input.idempotencyKey, input.orderId ?? null, input.amountEtb, input.customerPhone],
  );
  if (inserted.rows[0]) {
    return { payment: toPayment(inserted.rows[0]), created: true };
  }
  // Someone already created it — return the existing, authoritative row.
  const existing = await getByKey(input.idempotencyKey);
  return { payment: existing!, created: false };
}

/**
 * Payments that timed out, were parked as PENDING_VERIFY, and have not settled
 * within `olderThanSeconds`. These are the long-tail cases where both the async
 * webhook and the queue's retries failed to resolve the charge — the reconciler
 * sweep re-queries the gateway for them so money is never left in limbo.
 */
export async function listStuckPendingVerify(
  olderThanSeconds: number,
  limit = 100,
): Promise<Payment[]> {
  const { rows } = await pool.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE status = 'PENDING_VERIFY'
        AND updated_at < now() - ($1 * interval '1 second')
      ORDER BY updated_at ASC
      LIMIT $2`,
    [olderThanSeconds, limit],
  );
  return rows.map(toPayment);
}

export async function getByKey(idempotencyKey: string): Promise<Payment | null> {
  const { rows } = await pool.query<PaymentRow>(
    `SELECT * FROM payments WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0] ? toPayment(rows[0]) : null;
}

/**
 * Move a payment to a new status, but only from an expected prior status (optimistic
 * guard). This prevents a late-arriving retry from flipping an already-SUCCESS
 * payment back to FAILED, etc. Terminal states are never overwritten.
 */
export async function updateStatus(
  idempotencyKey: string,
  next: PaymentStatus,
  patch: { telebirrRef?: string | null; lastError?: string | null; bumpAttempt?: boolean } = {},
): Promise<Payment | null> {
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payments
        SET status      = $2,
            telebirr_ref = COALESCE($3, telebirr_ref),
            last_error   = $4,
            attempts     = attempts + $5,
            updated_at   = now()
      WHERE idempotency_key = $1
        AND status NOT IN ('SUCCESS','FAILED')   -- never resurrect a terminal payment
      RETURNING *`,
    [
      idempotencyKey,
      next,
      patch.telebirrRef ?? null,
      patch.lastError ?? null,
      patch.bumpAttempt ? 1 : 0,
    ],
  );
  return rows[0] ? toPayment(rows[0]) : getByKey(idempotencyKey);
}
