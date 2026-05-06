import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { LocalOwnershipGate } from "./local-ownership-gate.js";

describe("LocalOwnershipGate", () => {
  test("acquire returns a lease for a new binding id", async () => {
    const gate = new LocalOwnershipGate();
    const lease = await gate.acquire("binding-1");

    assert.ok(lease !== null);
    assert.equal(lease?.bindingId, "binding-1");
    assert.ok(typeof lease?.token === "string");
    assert.ok(lease?.token.length > 0);
  });

  test("acquire returns null when the binding is already held", async () => {
    const gate = new LocalOwnershipGate();
    await gate.acquire("binding-1");

    const second = await gate.acquire("binding-1");
    assert.equal(second, null);
  });

  test("acquire can hold multiple distinct binding ids simultaneously", async () => {
    const gate = new LocalOwnershipGate();
    const leaseA = await gate.acquire("binding-a");
    const leaseB = await gate.acquire("binding-b");

    assert.ok(leaseA !== null);
    assert.ok(leaseB !== null);
    assert.notEqual(leaseA?.token, leaseB?.token);
  });

  test("renew returns true for the holder's own lease", async () => {
    const gate = new LocalOwnershipGate();
    const lease = await gate.acquire("binding-1");

    assert.ok(lease !== null);
    const renewed = await gate.renew(lease!);
    assert.equal(renewed, true);
  });

  test("renew returns false for a stale or unknown token", async () => {
    const gate = new LocalOwnershipGate();
    await gate.acquire("binding-1");

    const stale = { bindingId: "binding-1", token: "wrong-token" };
    const renewed = await gate.renew(stale);
    assert.equal(renewed, false);
  });

  test("renew returns false for a binding not held by the gate", async () => {
    const gate = new LocalOwnershipGate();
    const never = { bindingId: "not-held", token: "some-token" };

    const renewed = await gate.renew(never);
    assert.equal(renewed, false);
  });

  test("release removes the lease for the matching token", async () => {
    const gate = new LocalOwnershipGate();
    const lease = await gate.acquire("binding-1");

    await gate.release(lease!);

    const held = await gate.isHeld("binding-1");
    assert.equal(held, false);
  });

  test("release is a no-op for a stale token", async () => {
    const gate = new LocalOwnershipGate();
    await gate.acquire("binding-1");

    await gate.release({ bindingId: "binding-1", token: "wrong-token" });

    const held = await gate.isHeld("binding-1");
    assert.equal(held, true);
  });

  test("isHeld returns true while the binding is acquired", async () => {
    const gate = new LocalOwnershipGate();
    await gate.acquire("binding-1");

    assert.equal(await gate.isHeld("binding-1"), true);
  });

  test("isHeld returns false before acquisition", async () => {
    const gate = new LocalOwnershipGate();
    assert.equal(await gate.isHeld("binding-1"), false);
  });

  test("a released binding can be re-acquired", async () => {
    const gate = new LocalOwnershipGate();
    const first = await gate.acquire("binding-1");
    await gate.release(first!);

    const second = await gate.acquire("binding-1");
    assert.ok(second !== null);
    assert.equal(second?.bindingId, "binding-1");
  });
});
