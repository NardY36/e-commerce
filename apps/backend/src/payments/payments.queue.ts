import { Queue, Worker, type Job } from "bullmq";
import { redis } from "../redis.js";
import { log } from "../logger.js";
import * as repo from "./payments.repo.js";
import {
  initiatePayment,
  queryStatus,
  scheduleWebhookCallback,
  GatewayTimeoutError,
} from "./telebirr.mock.js";

const QUEUE_NAME = "payments";

/** Payload is tiny on purpose — the DB row is the source of truth, not the job. */
interface PaymentJobData {
  idempotencyKey: string;
}

export const paymentsQueue = new Queue<PaymentJobData>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    // Retry with exponential backoff. Each retry re-verifies via queryStatus,
    // it does NOT re-initiate — so retries can never double-charge.
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/**
 * Enqueue the actual payment processing. We set jobId = idempotencyKey so BullMQ
 * itself refuses to create a second job for the same payment — a third layer of
 * de-duplication on top of the DB unique constraint and the gateway's own ref.
 */
export async function enqueuePayment(idempotencyKey: string): Promise<void> {
  await paymentsQueue.add(
    "process",
    { idempotencyKey },
    { jobId: idempotencyKey },
  );
}

const CLIENT_TIMEOUT_MS = 2000; // how long we wait on Telebirr before giving up

/**
 * Settle a payment from an async gateway webhook. Called by the webhook route once
 * Telebirr tells us the real outcome of a charge whose response we never got. This
 * is the path that resolves the "timed out but actually succeeded" case correctly.
 */
export async function reconcileFromGateway(
  idempotencyKey: string,
  status: "SUCCESS" | "FAILED",
  telebirrRef?: string,
): Promise<void> {
  await repo.updateStatus(idempotencyKey, status, { telebirrRef, lastError: null });
  log.info("payment reconciled from gateway webhook", { idempotencyKey, status });
}

async function processJob(job: Job<PaymentJobData>): Promise<void> {
  const { idempotencyKey } = job.data;
  const payment = await repo.getByKey(idempotencyKey);
  if (!payment) throw new Error(`payment ${idempotencyKey} vanished`);

  // Already settled (e.g. the webhook beat the retry) — nothing to do.
  if (payment.status === "SUCCESS" || payment.status === "FAILED") {
    log.info("payment already terminal, skipping", { idempotencyKey, status: payment.status });
    return;
  }

  await repo.updateStatus(idempotencyKey, "PROCESSING", { bumpAttempt: true });

  // KEY DECISION: only the very first attempt initiates a charge. Every retry
  // merely QUERIES the gateway for the status of the same ref. That is what makes
  // timeouts safe — we reconcile an uncertain charge instead of repeating it.
  const isFirstAttempt = job.attemptsMade === 0;

  if (!isFirstAttempt) {
    const q = await queryStatus(idempotencyKey);
    if (q.status === "SUCCESS" || q.status === "FAILED") {
      await repo.updateStatus(idempotencyKey, q.status, { telebirrRef: q.telebirrRef });
      log.info("payment settled via status query on retry", { idempotencyKey, status: q.status });
      return;
    }
    throw new Error("status still unknown, will retry"); // triggers another backoff
  }

  try {
    const res = await initiatePayment(
      {
        merchantRef: idempotencyKey,
        amountEtb: payment.amountEtb,
        customerPhone: payment.customerPhone,
      },
      AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    );
    await repo.updateStatus(idempotencyKey, res.status, { telebirrRef: res.telebirrRef });
    log.info("payment settled on first attempt", { idempotencyKey, status: res.status });
  } catch (err) {
    if (err instanceof GatewayTimeoutError || (err as Error)?.name === "TimeoutError") {
      // We don't know the outcome. Park it as PENDING_VERIFY, ask the gateway to
      // call us back, and let BullMQ retry (which will queryStatus). We NEVER
      // initiate again for this key.
      await repo.updateStatus(idempotencyKey, "PENDING_VERIFY", {
        lastError: "gateway timeout; awaiting verification",
      });
      scheduleWebhookCallback(idempotencyKey);
      log.warn("payment timed out, parked for verification", { idempotencyKey });
      throw new Error("gateway timeout, awaiting verification"); // retry via backoff
    }
    await repo.updateStatus(idempotencyKey, "PENDING_VERIFY", { lastError: String(err) });
    throw err;
  }
}

/** Starts the background worker. Returns it so the process can close it cleanly. */
export function startPaymentWorker(): Worker<PaymentJobData> {
  const worker = new Worker<PaymentJobData>(QUEUE_NAME, processJob, {
    connection: redis,
    concurrency: 5,
  });
  worker.on("failed", (job, err) => {
    log.warn("payment job attempt failed", { jobId: job?.id, err: err.message });
  });
  worker.on("completed", (job) => {
    log.info("payment job completed", { jobId: job.id });
  });
  log.info("payment worker started");
  return worker;
}
