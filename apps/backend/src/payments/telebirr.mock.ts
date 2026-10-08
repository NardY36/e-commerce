import crypto from "node:crypto";
import { env } from "../env.js";
import { log } from "../logger.js";

/**
 * A stand-in for the real Telebirr (or Chapa) gateway. It exists so we can SEE the
 * resilience logic work: it injects two real-world failure modes on purpose —
 *
 *   1. The initiate call hangs past our client timeout (the single most common
 *      Telebirr symptom in Addis). Crucially, the gateway may STILL have processed
 *      the charge — so a naive "timed out, try again" would double-charge.
 *   2. The call hard-fails (declined / network reset).
 *
 * The important property we model from the real gateways: calls are keyed by a
 * merchant reference. Calling initiate twice with the same ref returns the SAME
 * result and never charges twice. That gateway-side idempotency, combined with
 * ours, is what guarantees exactly-once billing.
 */

export type GatewayStatus = "SUCCESS" | "FAILED";

interface GatewayRecord {
  merchantRef: string;
  telebirrRef: string;
  amountEtb: number;
  status: GatewayStatus; // the gateway's eventual *truth*, decided once
}

// The gateway's own ledger. In reality this lives on Telebirr's servers; here it
// is in-memory, keyed by our merchant reference (the idempotency key).
const ledger = new Map<string, GatewayRecord>();

export class GatewayTimeoutError extends Error {
  constructor() {
    super("Telebirr gateway timed out");
    this.name = "GatewayTimeoutError";
  }
}

function decideOutcome(): GatewayStatus {
  return Math.random() < env.TELEBIRR_FAILURE_RATE ? "FAILED" : "SUCCESS";
}

/** Random delay to make timeouts feel real; honors an AbortSignal for the timeout. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new GatewayTimeoutError());
    });
  });
}

export interface InitiateRequest {
  merchantRef: string; // our idempotency key
  amountEtb: number;
  customerPhone: string;
}

/**
 * Initiate a charge. Resolves with the gateway status, OR throws
 * GatewayTimeoutError — in which case the charge's true outcome is UNKNOWN to us
 * and must be verified asynchronously (webhook or queryStatus).
 */
export async function initiatePayment(
  req: InitiateRequest,
  signal?: AbortSignal,
): Promise<{ status: GatewayStatus; telebirrRef: string }> {
  // Gateway-side idempotency: a known ref always returns its first outcome.
  const existing = ledger.get(req.merchantRef);
  if (existing) {
    return { status: existing.status, telebirrRef: existing.telebirrRef };
  }

  // Decide and PERSIST the truth before we risk timing out. This models the
  // dangerous reality: the gateway may complete the charge even though our
  // connection dies before we hear back.
  const status = decideOutcome();
  const telebirrRef = "TB-" + crypto.randomBytes(5).toString("hex").toUpperCase();
  ledger.set(req.merchantRef, { ...req, telebirrRef, status });

  const willTimeout = Math.random() < env.TELEBIRR_TIMEOUT_RATE;
  if (willTimeout) {
    // Hang "forever"; the worker's AbortSignal.timeout fires and we reject.
    log.warn("telebirr: connection will time out (charge may still settle)", {
      merchantRef: req.merchantRef,
    });
    await delay(60_000, signal); // the abort rejects this with GatewayTimeoutError
  }

  // Fast, clean path.
  await delay(150, signal);
  return { status, telebirrRef };
}

/**
 * Query the gateway for the authoritative status of a ref. This is what we call on
 * RETRY — never initiate again — so a timed-out charge is reconciled, not repeated.
 */
export async function queryStatus(
  merchantRef: string,
): Promise<{ status: GatewayStatus | "UNKNOWN"; telebirrRef?: string }> {
  const rec = ledger.get(merchantRef);
  if (!rec) return { status: "UNKNOWN" };
  return { status: rec.status, telebirrRef: rec.telebirrRef };
}

// ─── Webhook signing (what the gateway uses to prove a callback is genuine) ────

export function signWebhookBody(rawBody: string, secret = env.TELEBIRR_WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret = env.TELEBIRR_WEBHOOK_SECRET,
): boolean {
  const expected = signWebhookBody(rawBody, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature ?? "", "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Simulate the gateway calling US back asynchronously once it settles a charge
 * whose response we never received. Fires a real signed HTTP POST at our webhook
 * so the whole callback path (signature check + reconciliation) is exercised.
 */
export function scheduleWebhookCallback(merchantRef: string, afterMs = 2500): void {
  setTimeout(async () => {
    const rec = ledger.get(merchantRef);
    if (!rec) return;
    const payload = JSON.stringify({
      merchantRef,
      telebirrRef: rec.telebirrRef,
      status: rec.status,
    });
    const signature = signWebhookBody(payload);
    try {
      await fetch(`${env.PUBLIC_BASE_URL}/api/payments/telebirr/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telebirr-signature": signature },
        body: payload,
      });
      log.info("telebirr: async webhook delivered", { merchantRef, status: rec.status });
    } catch (err) {
      log.warn("telebirr: webhook delivery failed (will rely on poll)", {
        merchantRef,
        err: String(err),
      });
    }
  }, afterMs);
}
