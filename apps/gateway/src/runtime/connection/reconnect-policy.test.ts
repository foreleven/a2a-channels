import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createReconnectPolicy } from "./reconnect-policy.js";

describe("createReconnectPolicy", () => {
  test("attempt 1 returns base delay", () => {
    const policy = createReconnectPolicy({ baseDelayMs: 500, maxDelayMs: 10000 });
    const result = policy.next(1);

    assert.equal(result.attempt, 1);
    assert.equal(result.delayMs, 500);
  });

  test("doubles delay on each successive attempt", () => {
    const policy = createReconnectPolicy({ baseDelayMs: 100, maxDelayMs: 10000 });

    assert.equal(policy.next(1).delayMs, 100);
    assert.equal(policy.next(2).delayMs, 200);
    assert.equal(policy.next(3).delayMs, 400);
    assert.equal(policy.next(4).delayMs, 800);
  });

  test("caps delay at maxDelayMs", () => {
    const policy = createReconnectPolicy({ baseDelayMs: 1000, maxDelayMs: 3000 });

    assert.equal(policy.next(1).delayMs, 1000);
    assert.equal(policy.next(2).delayMs, 2000);
    assert.equal(policy.next(3).delayMs, 3000);
    assert.equal(policy.next(10).delayMs, 3000);
  });

  test("uses defaults when no options provided", () => {
    const policy = createReconnectPolicy();

    // default baseDelayMs = 1000
    assert.equal(policy.next(1).delayMs, 1000);
    // attempt 6: 1000 * 2^5 = 32000, capped at 30000 (default max)
    assert.equal(policy.next(6).delayMs, 30000);
  });

  test("clamps attempt 0 to 1", () => {
    const policy = createReconnectPolicy({ baseDelayMs: 200, maxDelayMs: 5000 });
    const result = policy.next(0);

    assert.equal(result.attempt, 1);
    assert.equal(result.delayMs, 200);
  });

  test("clamps negative attempt to 1", () => {
    const policy = createReconnectPolicy({ baseDelayMs: 200, maxDelayMs: 5000 });
    const result = policy.next(-3);

    assert.equal(result.attempt, 1);
    assert.equal(result.delayMs, 200);
  });

  test("returns the safe attempt value in the decision", () => {
    const policy = createReconnectPolicy({ baseDelayMs: 100, maxDelayMs: 10000 });

    assert.equal(policy.next(5).attempt, 5);
    assert.equal(policy.next(0).attempt, 1);
  });
});
