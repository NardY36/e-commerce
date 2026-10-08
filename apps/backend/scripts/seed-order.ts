import { env } from "../src/env.js";
import { log } from "../src/logger.js";
import { migrate } from "../src/db/migrate.js";
import * as orders from "../src/orders/orders.repo.js";
import { pool } from "../src/db/pool.js";

/**
 * Seeds the demo "Order #1048" and, if a bot + MERCHANT_CHAT_ID are configured,
 * pushes the alert to Telegram. Run with: `pnpm seed:order`.
 *
 * Note: this talks to Telegram directly via the Bot API rather than importing the
 * running bot, so it works whether or not `pnpm dev` is up.
 */
async function main() {
  await migrate();

  const order = await orders.upsertOrder({
    orderNumber: 1048,
    merchantChatId: env.MERCHANT_CHAT_ID || null,
    itemName: "CeraVe Hydrating Cleanser",
    quantity: 1,
    amountEtb: 2500,
    courierEtaMin: 8,
  });
  log.info("seeded order", { order });

  if (env.telegramEnabled && env.MERCHANT_CHAT_ID) {
    const { Bot, InlineKeyboard } = await import("grammy");
    const b = new Bot(env.TELEGRAM_BOT_TOKEN);
    const keyboard = new InlineKeyboard()
      .text("✅ In Stock – Confirm", `confirm:${order.orderNumber}`)
      .row()
      .webApp("🛍 Open Store Portal", `${env.PUBLIC_BASE_URL}/miniapp`);
    const nf = new Intl.NumberFormat("en-ET");
    await b.api.sendMessage(
      env.MERCHANT_CHAT_ID,
      `🛍 Order #${order.orderNumber} — ${order.quantity}x ${order.itemName} ` +
        `(${nf.format(order.amountEtb)} ETB) | Courier ETA: ${order.courierEtaMin} mins`,
      { reply_markup: keyboard },
    );
    log.info("pushed order alert to Telegram", { chatId: env.MERCHANT_CHAT_ID });
  } else {
    log.warn("skipped Telegram push (need TELEGRAM_BOT_TOKEN + MERCHANT_CHAT_ID)");
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error("seed failed", { err: String(err) });
  process.exit(1);
});
