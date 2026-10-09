import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, ORDER_STATES, type OrderState } from "./order.types.js";

test("the happy path is allowed end to end", () => {
  assert.ok(canTransition("PENDING", "READY_FOR_PICKUP"));
  assert.ok(canTransition("READY_FOR_PICKUP", "PICKED_UP"));
  assert.ok(canTransition("PICKED_UP", "DELIVERED"));
});

test("an order can be cancelled from any non-terminal state", () => {
  assert.ok(canTransition("PENDING", "CANCELLED"));
  assert.ok(canTransition("READY_FOR_PICKUP", "CANCELLED"));
  assert.ok(canTransition("PICKED_UP", "CANCELLED"));
});

test("terminal states cannot transition anywhere", () => {
  for (const to of ORDER_STATES) {
    assert.equal(canTransition("DELIVERED", to), false, `DELIVERED -> ${to}`);
    assert.equal(canTransition("CANCELLED", to), false, `CANCELLED -> ${to}`);
  }
});

test("illegal jumps are rejected (this is what protects the 1-tap confirm)", () => {
  // A double-delivered 'confirm' tap must not skip the pickup step.
  assert.equal(canTransition("PENDING", "PICKED_UP"), false);
  assert.equal(canTransition("PENDING", "DELIVERED"), false);
  // Can't go backwards.
  assert.equal(canTransition("PICKED_UP", "PENDING"), false);
  assert.equal(canTransition("READY_FOR_PICKUP", "PENDING"), false);
});

test("a state is never a valid transition to itself (idempotency handled above it)", () => {
  for (const s of ORDER_STATES) {
    assert.equal(canTransition(s as OrderState, s as OrderState), false, `${s} -> ${s}`);
  }
});
