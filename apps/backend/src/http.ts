import express, { type Express, type Request, type Response } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { miniappRouter } from "./miniapp/miniapp.routes.js";
import { paymentsRouter } from "./payments/payments.routes.js";
import { courierRouter } from "./courier/courier.routes.js";
import * as orders from "./orders/orders.repo.js";
import { sendOrderAlert, bot } from "./bot/bot.js";
import { env } from "./env.js";

/**
 * Assembles the HTTP surface. Note we do NOT install a global JSON body parser —
 * the Telebirr webhook needs the raw bytes to verify its signature, so each route
 * opts into the parser it needs (see payments.routes.ts).
 */
export function createApp(): Express {
  const app = express();
  const here = dirname(fileURLToPath(import.meta.url));

  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // The Mini App webview (static). Opened by the bot's "Open Store Portal" button.
  app.use("/miniapp", express.static(join(here, "miniapp", "public")));

  // JSON APIs.
  app.use("/api/miniapp", miniappRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/courier", courierRouter);

  // ─── Demo helpers ──────────────────────────────────────────────────────────
  // Trigger the Order #1048 alert over HTTP, so you can fire it while narrating
  // the demo without typing in Telegram. Requires MERCHANT_CHAT_ID + a bot token.
  app.post("/debug/new-order", express.json(), async (_req: Request, res: Response) => {
    const order = await orders.upsertOrder({
      orderNumber: 1048,
      merchantChatId: env.MERCHANT_CHAT_ID || null,
      itemName: "CeraVe Hydrating Cleanser",
      quantity: 1,
      amountEtb: 2500,
      courierEtaMin: 8,
    });
    if (bot && env.MERCHANT_CHAT_ID) {
      await sendOrderAlert(env.MERCHANT_CHAT_ID, order);
      return res.json({ sent: true, order });
    }
    res.json({ sent: false, reason: "no bot token or MERCHANT_CHAT_ID", order });
  });

  // Inspect an order's current state.
  app.get("/debug/order/:n", async (req: Request, res: Response) => {
    const order = await orders.getByNumber(Number(req.params.n));
    if (!order) return res.status(404).json({ error: "not_found" });
    res.json(order);
  });

  return app;
}
