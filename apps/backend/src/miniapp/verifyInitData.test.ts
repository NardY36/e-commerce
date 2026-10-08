import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyInitData } from "./verifyInitData.js";

const BOT_TOKEN = "123456:TEST_TOKEN_abcDEF";

/** Produce a correctly-signed initData string, the way Telegram would. */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const freshAuthDate = () => String(Math.floor(Date.now() / 1000));

test("accepts a correctly-signed, fresh payload", () => {
  const initData = signInitData({
    auth_date: freshAuthDate(),
    query_id: "AAE",
    user: JSON.stringify({ id: 42, first_name: "Meron", username: "meron" }),
  });
  const res = verifyInitData(initData, BOT_TOKEN);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.user.id, 42);
});

test("rejects a tampered payload (wrong signature)", () => {
  let initData = signInitData({
    auth_date: freshAuthDate(),
    user: JSON.stringify({ id: 42, first_name: "Meron" }),
  });
  // Attacker swaps in a different user but keeps the old hash.
  initData = initData.replace("Meron", "Attacker");
  const res = verifyInitData(initData, BOT_TOKEN);
  assert.equal(res.ok, false);
});

test("rejects a payload signed with the wrong bot token", () => {
  const initData = signInitData(
    { auth_date: freshAuthDate(), user: JSON.stringify({ id: 1 }) },
    "999999:SOMEONE_ELSES_TOKEN",
  );
  const res = verifyInitData(initData, BOT_TOKEN);
  assert.equal(res.ok, false);
});

test("rejects a stale payload (replay protection)", () => {
  const twoHoursAgo = String(Math.floor(Date.now() / 1000) - 2 * 60 * 60);
  const initData = signInitData({
    auth_date: twoHoursAgo,
    user: JSON.stringify({ id: 42, first_name: "Meron" }),
  });
  const res = verifyInitData(initData, BOT_TOKEN);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /too old/);
});

test("rejects when no bot token is configured on the server", () => {
  const res = verifyInitData("whatever", "");
  assert.equal(res.ok, false);
});
