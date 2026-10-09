import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * All configuration is read once, validated, and frozen. If a required value is
 * missing or malformed the process refuses to start — we never want a half-booted
 * server silently talking to the wrong database in production.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  MERCHANT_CHAT_ID: z.string().optional().default(""),

  DATABASE_URL: z.string().default("postgres://ecommerce:ecommerce@localhost:5432/ecommerce"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  TELEBIRR_TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0.6),
  TELEBIRR_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  TELEBIRR_WEBHOOK_SECRET: z.string().default("telebirr-sandbox-secret"),
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  /** True when a real Telegram token is configured; drives live-bot features. */
  telegramEnabled: parsed.TELEGRAM_BOT_TOKEN.length > 0,
} as const;

export type Env = typeof env;
