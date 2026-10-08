import crypto from "node:crypto";

/**
 * Validates the `initData` string that Telegram injects into every Mini App
 * webview. This is how a merchant proves their identity to our backend WITHOUT a
 * password — Telegram has already authenticated them, and signs the payload with
 * a key derived from our bot token. If the signature checks out, the enclosed
 * user object is trustworthy.
 *
 * Algorithm (per Telegram's "Validating data" spec):
 *   1. Parse initData as a querystring.
 *   2. Pull out `hash`; every other field forms the data-check-string:
 *      sorted "key=value" lines joined by "\n".
 *   3. secret   = HMAC_SHA256(key="WebAppData", message=botToken)
 *   4. expected = HMAC_SHA256(key=secret,       message=dataCheckString)  (hex)
 *   5. Constant-time compare expected vs the supplied hash.
 *
 * We additionally reject stale payloads (replay protection) using auth_date.
 */
export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type VerifyResult =
  | { ok: true; user: TelegramUser; authDate: Date; raw: URLSearchParams }
  | { ok: false; reason: string };

const MAX_AGE_SECONDS = 60 * 60; // reject initData older than 1 hour

export function verifyInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds?: number; now?: Date } = {},
): VerifyResult {
  if (!botToken) return { ok: false, reason: "server has no bot token configured" };
  if (!initData) return { ok: false, reason: "missing initData" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };

  // Build the data-check-string: all fields except `hash`, sorted by key.
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  // Constant-time comparison to avoid leaking the hash via timing.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }

  // Replay protection: initData must be recent.
  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw ? new Date(Number(authDateRaw) * 1000) : null;
  if (!authDate || Number.isNaN(authDate.getTime())) {
    return { ok: false, reason: "missing or invalid auth_date" };
  }
  const now = opts.now ?? new Date();
  const ageSeconds = (now.getTime() - authDate.getTime()) / 1000;
  const maxAge = opts.maxAgeSeconds ?? MAX_AGE_SECONDS;
  if (ageSeconds > maxAge) {
    return { ok: false, reason: `initData too old (${Math.round(ageSeconds)}s)` };
  }

  // Signature is valid — the `user` field can be trusted.
  let user: TelegramUser;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    return { ok: false, reason: "user field is not valid JSON" };
  }
  if (!user || typeof user.id !== "number") {
    return { ok: false, reason: "user field missing id" };
  }

  return { ok: true, user, authDate, raw: params };
}
