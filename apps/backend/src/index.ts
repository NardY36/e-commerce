import { env } from "./env.js";
import { log } from "./logger.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http.js";
import { startPaymentWorker } from "./payments/payments.queue.js";
import { startReconciler } from "./payments/reconciler.js";
import { bot } from "./bot/bot.js";
import { pool } from "./db/pool.js";
import { redis } from "./redis.js";

async function main() {
  // 1. Ensure the schema exists (idempotent).
  await migrate();

  // 2. Start the background payment worker (Telebirr resilience lives here) and
  //    the reconciler sweep (the safety net for payments stuck in PENDING_VERIFY).
  const worker = startPaymentWorker();
  const reconciler = startReconciler();

  // 3. Start the HTTP server (APIs + Mini App + webhooks).
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info("http listening", { port: env.PORT, url: env.PUBLIC_BASE_URL });
  });

  // 4. Start the Telegram bot via long-polling (no public URL needed for the bot
  //    itself; only the Mini App button needs an HTTPS tunnel — see README).
  if (bot) {
    bot.start({ onStart: (me) => log.info("bot started", { username: me.username }) });
  } else {
    log.warn("TELEGRAM_BOT_TOKEN not set — running without a live bot", {
      hint: "APIs, payments and the Mini App server still work for development",
    });
  }

  // 5. Graceful shutdown so Redis/PG connections and the bot close cleanly.
  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await bot?.stop();
    reconciler.stop();
    await worker.close();
    server.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal boot error", { err: String(err) });
  process.exit(1);
});
