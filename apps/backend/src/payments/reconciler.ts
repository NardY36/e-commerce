import { log } from "../logger.js";
import * as repo from "./payments.repo.js";
import { queryStatus } from "./telebirr.mock.js";

/**
 * Safety-net sweep for payments that got stuck in PENDING_VERIFY — i.e. a charge
 * timed out, and NEITHER the async gateway webhook NOR the queue's bounded retries
 * ever settled it. Without this, such a payment would sit in limbo forever.
 *
 * The sweep periodically re-queries the gateway for each stuck payment's status and
 * settles it. It is safe precisely because it QUERIES — it never re-initiates — so,
 * like every other path in this system, it cannot double-charge. updateStatus's
 * terminal-state guard also makes a settle here idempotent against a webhook that
 * arrives at the same time.
 */
export interface ReconcilerOptions {
  /** How often to run the sweep. */
  intervalMs?: number;
  /** Only touch payments that have been stuck at least this long. */
  stuckAfterSeconds?: number;
}

export function startReconciler(opts: ReconcilerOptions = {}): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 30_000;
  const stuckAfterSeconds = opts.stuckAfterSeconds ?? 60;

  const tick = async () => {
    try {
      const stuck = await repo.listStuckPendingVerify(stuckAfterSeconds);
      if (stuck.length === 0) return;
      log.info("reconciler sweeping stuck payments", { count: stuck.length });
      for (const p of stuck) {
        const q = await queryStatus(p.idempotencyKey);
        if (q.status === "SUCCESS" || q.status === "FAILED") {
          await repo.updateStatus(p.idempotencyKey, q.status, { telebirrRef: q.telebirrRef });
          log.info("reconciler settled stuck payment", {
            idempotencyKey: p.idempotencyKey,
            status: q.status,
          });
        }
        // Still UNKNOWN at the gateway — leave it; a later sweep will retry.
      }
    } catch (err) {
      log.error("reconciler sweep failed", { err: String(err) });
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't let this timer keep the process alive on its own.
  timer.unref?.();
  log.info("payment reconciler started", { intervalMs, stuckAfterSeconds });
  return { stop: () => clearInterval(timer) };
}
