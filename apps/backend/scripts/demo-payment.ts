import { randomUUID } from "node:crypto";

/**
 * Drives the payment resilience demo end-to-end against a running server:
 *   1. POST a payment intent (idempotency key).
 *   2. Immediately POST the SAME key again — proving the duplicate is ignored.
 *   3. Poll status until the payment settles, showing how a Telebirr timeout is
 *      parked as PENDING_VERIFY and then reconciled (webhook / status query)
 *      WITHOUT ever charging twice.
 *
 * Run the server first (`pnpm dev`), then: `pnpm tsx scripts/demo-payment.ts`.
 */
const BASE = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

async function post(key: string) {
  const res = await fetch(`${BASE}/api/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: key,
      amountEtb: 2500,
      customerPhone: "+251911223344",
    }),
  });
  return { http: res.status, body: await res.json() };
}

async function status(key: string) {
  const res = await fetch(`${BASE}/api/payments/${key}`);
  return res.json() as Promise<Record<string, unknown>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = `demo-${randomUUID()}`;
  console.log(`\n▶ idempotency key: ${key}\n`);

  const first = await post(key);
  console.log("1st POST  ->", first.http, first.body);

  const dup = await post(key);
  console.log("2nd POST  ->", dup.http, dup.body, "  (should say deduplicated: true)\n");

  // Poll until terminal.
  for (let i = 0; i < 20; i++) {
    const s = await status(key);
    console.log(`poll ${String(i).padStart(2)}  -> ${s.status}  attempts=${s.attempts}`);
    if (s.status === "SUCCESS" || s.status === "FAILED") {
      console.log(`\n✔ settled as ${s.status}, telebirrRef=${s.telebirrRef}\n`);
      break;
    }
    await sleep(1500);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
