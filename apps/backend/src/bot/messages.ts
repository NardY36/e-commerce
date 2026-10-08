import type { Order } from "../orders/order.types.js";

const nf = new Intl.NumberFormat("en-ET");

/** The push-alert text, matching the brief's format exactly. */
export function orderAlertText(order: Order): string {
  const eta = order.courierEtaMin != null ? ` | Courier ETA: ${order.courierEtaMin} mins` : "";
  return (
    `🛍 Order #${order.orderNumber} — ${order.quantity}x ${order.itemName} ` +
    `(${nf.format(order.amountEtb)} ETB)${eta}`
  );
}

/** Shown after the merchant taps “In Stock – Confirm”. */
export function orderConfirmedText(order: Order, latencyMs: number): string {
  return (
    `✅ Order #${order.orderNumber} confirmed — READY_FOR_PICKUP\n` +
    `${order.quantity}x ${order.itemName} · ${nf.format(order.amountEtb)} ETB\n` +
    `Backend updated in ${latencyMs} ms. Courier notified.`
  );
}
