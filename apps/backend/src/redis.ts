import { Redis } from "ioredis";
import { env } from "./env.js";

/**
 * Shared Redis connection for BullMQ. `maxRetriesPerRequest: null` is required by
 * BullMQ so blocking commands aren't aborted mid-wait.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
