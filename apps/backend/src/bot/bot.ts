import { Bot, InlineKeyboard } from "grammy";
import { env } from "../env.js";
import { log } from "../logger.js";
import * as orders from "../orders/orders.repo.js";
import { InvalidTransitionError } from "../orders/orders.repo.js";
import type { Order } from "../orders/order.types.js";
import { orderAlertText, orderConfirmedText } from "./messages.js";

/**
 * The merchant-facing Telegram bot. Two surfaces, per the brief:
 *   • Push Alert  — a new order arrives as a message with two inline buttons.
 *   • Portal      — the "Open Store Portal" button launches the Mini App webview.
 *
 * `null` when no token is configured, so the rest of the app (HTTP APIs, worker)
 * still boots for offline development.
 */
export const bot: Bot | null = env.telegramEnabled ? new Bot(env.TELEGRAM_BOT_TOKEN) : null;

const CONFIRM_PREFIX = "confirm:";

/** Build the inline keyboard: a 1-tap confirm + the Mini App launch button. */
function orderKeyboard(order: Order): InlineKeyboard {
  const miniAppUrl = `${env.PUBLIC_BASE_URL}/miniapp`;
  return new InlineKeyboard()
    .text("✅ In Stock – Confirm", `${CONFIRM_PREFIX}${order.orderNumber}`)
    .row()
    // web_app buttons require an HTTPS URL; see README for the tunnel step.
    .webApp("🛍 Open Store Portal", miniAppUrl);
}

/** Push a new-order alert to a chat. Used by the demo trigger + seed script. */
export async function sendOrderAlert(chatId: string | number, order: Order): Promise<void> {
  if (!bot) throw new Error("bot is not configured (no TELEGRAM_BOT_TOKEN)");
  await bot.api.sendMessage(chatId, orderAlertText(order), {
    reply_markup: orderKeyboard(order),
  });
}

if (bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "E-Commerce merchant bot online.\n" +
        `Your chat id is ${ctx.chat.id} — put it in MERCHANT_CHAT_ID to receive order alerts.\n` +
        "Send /neworder to simulate an incoming order.",
    );
  });

  // Demo trigger: simulate Order #1048 arriving at the Bole cosmetics store.
  bot.command("neworder", async (ctx) => {
    const order = await orders.upsertOrder({
      orderNumber: 1048,
      merchantChatId: String(ctx.chat.id),
      itemName: "CeraVe Hydrating Cleanser",
      quantity: 1,
      amountEtb: 2500,
      courierEtaMin: 8,
    });
    await sendOrderAlert(ctx.chat.id, order);
  });

  /**
   * 1-Tap Fast Confirmation. The merchant's tap is delivered to this backend as a
   * Telegram update (a webhook in production, long-polling in local dev). We flip
   * the order to READY_FOR_PICKUP and acknowledge — comfortably inside the 2s SLA.
   */
  bot.callbackQuery(new RegExp(`^${CONFIRM_PREFIX}(\\d+)$`), async (ctx) => {
    const started = Date.now();
    const orderNumber = Number(ctx.match![1]);
    try {
      const order = await orders.transition(orderNumber, "READY_FOR_PICKUP");
      const latencyMs = Date.now() - started;

      // Answer the callback first (removes the button's loading spinner instantly).
      await ctx.answerCallbackQuery({ text: `Confirmed in ${latencyMs} ms ✅` });
      await ctx.editMessageText(orderConfirmedText(order, latencyMs));
      log.info("order confirmed via bot", { orderNumber, latencyMs, state: order.state });
    } catch (err) {
      const msg =
        err instanceof InvalidTransitionError
          ? "This order can no longer be confirmed."
          : "Could not confirm — please retry.";
      await ctx.answerCallbackQuery({ text: msg, show_alert: true });
      log.warn("order confirm failed", { orderNumber, err: String(err) });
    }
  });

  bot.catch((err) => log.error("bot error", { err: String(err.error) }));
}
