import { Router, type Request, type Response } from "express";
import express from "express";
import { z } from "zod";
import { log } from "../logger.js";
import * as repo from "./payments.repo.js";
import { enqueuePayment, reconcileFromGateway } from "./payments.queue.js";
import { verifyWebhookSignature } from "./telebirr.mock.js";

export const paymentsRouter = Router();

const CreatePayment = z.object({
  idempotencyKey: z.string().min(8, "provide a stable client-generated idempotency key"),
  orderId: z.string().uuid().optional(),
  amountEtb: z.number().positive(),
  customerPhone: z.string().min(7),
});

/**
 * Accept a payment intent. This returns in milliseconds no matter what Telebirr is
 * doing — we persist the intent, queue the work, and respond 202 Accepted. The
 * customer is never left staring at a spinner tied to a flaky upstream.
 *
 * Idempotent by contract: resubmitting the same idempotencyKey returns the current
 * state of the one-and-only payment, and never enqueues a second charge.
 */
paymentsRouter.post("/", express.json(), async (req: Request, res: Response) => {
  const parsed = CreatePayment.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  }
  const { idempotencyKey, orderId, amountEtb, customerPhone } = parsed.data;

  const { payment, created } = await repo.createOrGetIntent({
    idempotencyKey,
    orderId: orderId ?? null,
    amountEtb,
    customerPhone,
  });

  if (created) {
    await enqueuePayment(idempotencyKey);
    log.info("payment accepted + queued", { idempotencyKey, amountEtb });
  } else {
    log.info("duplicate payment request ignored (idempotent)", {
      idempotencyKey,
      status: payment.status,
    });
  }

  res.status(created ? 202 : 200).json({
    idempotencyKey: payment.idempotencyKey,
    status: payment.status,
    amountEtb: payment.amountEtb,
    telebirrRef: payment.telebirrRef,
    deduplicated: !created,
  });
});

/** Poll a payment's current status. */
paymentsRouter.get("/:idempotencyKey", async (req: Request, res: Response) => {
  const payment = await repo.getByKey(req.params.idempotencyKey!);
  if (!payment) return res.status(404).json({ error: "not_found" });
  res.json({
    idempotencyKey: payment.idempotencyKey,
    status: payment.status,
    amountEtb: payment.amountEtb,
    telebirrRef: payment.telebirrRef,
    attempts: payment.attempts,
    lastError: payment.lastError,
  });
});

/**
 * Telebirr's async callback. Mounted with a RAW body parser because we must verify
 * the HMAC signature over the exact bytes the gateway signed — re-serializing a
 * parsed object could change key order / whitespace and break the check.
 */
const WebhookBody = z.object({
  merchantRef: z.string(),
  telebirrRef: z.string().optional(),
  status: z.enum(["SUCCESS", "FAILED"]),
});

paymentsRouter.post(
  "/telebirr/webhook",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const raw = (req.body as Buffer)?.toString("utf8") ?? "";
    const signature = req.header("x-telebirr-signature") ?? "";

    if (!verifyWebhookSignature(raw, signature)) {
      log.warn("telebirr webhook rejected: bad signature");
      return res.status(401).json({ error: "bad_signature" });
    }

    const parsed = WebhookBody.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_payload" });
    }
    const { merchantRef, status, telebirrRef } = parsed.data;
    await reconcileFromGateway(merchantRef, status, telebirrRef);

    // Always 200 a verified webhook so the gateway stops retrying it.
    res.json({ ok: true });
  },
);
