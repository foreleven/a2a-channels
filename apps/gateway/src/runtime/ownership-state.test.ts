import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelBindingSnapshot } from "@agent-relay/domain";

import {
  areBindingsEquivalent,
  RuntimeOwnershipState,
} from "./ownership-state.js";

function makeBinding(
  overrides: Partial<ChannelBindingSnapshot> = {},
): ChannelBindingSnapshot {
  return {
    id: "binding-1",
    name: "Test Binding",
    channelType: "feishu",
    accountId: "default",
    channelConfig: { appId: "cli_1", appSecret: "sec_1" },
    agentId: "agent-1",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("areBindingsEquivalent", () => {
  test("returns true for identical bindings", () => {
    const b = makeBinding();
    assert.equal(areBindingsEquivalent(b, { ...b }), true);
  });

  test("returns false when name differs", () => {
    const left = makeBinding({ name: "A" });
    const right = makeBinding({ name: "B" });
    assert.equal(areBindingsEquivalent(left, right), false);
  });

  test("returns false when channelType differs", () => {
    const left = makeBinding({ channelType: "feishu" });
    const right = makeBinding({ channelType: "lark" });
    assert.equal(areBindingsEquivalent(left, right), false);
  });

  test("returns false when accountId differs", () => {
    const left = makeBinding({ accountId: "default" });
    const right = makeBinding({ accountId: "other" });
    assert.equal(areBindingsEquivalent(left, right), false);
  });

  test("returns false when agentId differs", () => {
    const left = makeBinding({ agentId: "agent-1" });
    const right = makeBinding({ agentId: "agent-2" });
    assert.equal(areBindingsEquivalent(left, right), false);
  });

  test("returns false when enabled flag differs", () => {
    const left = makeBinding({ enabled: true });
    const right = makeBinding({ enabled: false });
    assert.equal(areBindingsEquivalent(left, right), false);
  });

  test("returns false when channelConfig differs", () => {
    const left = makeBinding({ channelConfig: { appId: "a" } });
    const right = makeBinding({ channelConfig: { appId: "b" } });
    assert.equal(areBindingsEquivalent(left, right), false);
  });

  test("ignores id and createdAt in the comparison", () => {
    const left = makeBinding({ id: "binding-1", createdAt: "2026-01-01T00:00:00.000Z" });
    const right = makeBinding({ id: "binding-99", createdAt: "2099-12-31T00:00:00.000Z" });
    assert.equal(areBindingsEquivalent(left, right), true);
  });
});

describe("RuntimeOwnershipState", () => {
  describe("attachBinding / getOwnedBinding / listOwnedBindings", () => {
    test("attachBinding makes binding visible via getOwnedBinding", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding();

      state.attachBinding(binding);
      const owned = state.getOwnedBinding(binding.id);

      assert.ok(owned !== undefined);
      assert.equal(owned?.binding.id, "binding-1");
      assert.equal(owned?.status.status, "idle");
      assert.equal(owned?.reconnectAttempt, 0);
    });

    test("listOwnedBindings returns all attached bindings sorted by id", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding({ id: "binding-z" }));
      state.attachBinding(makeBinding({ id: "binding-a" }));

      const list = state.listOwnedBindings();
      assert.equal(list.length, 2);
      assert.equal(list[0]?.binding.id, "binding-a");
      assert.equal(list[1]?.binding.id, "binding-z");
    });

    test("getOwnedBinding returns undefined for unknown id", () => {
      const state = new RuntimeOwnershipState();
      assert.equal(state.getOwnedBinding("unknown"), undefined);
    });
  });

  describe("upsertBinding", () => {
    test("inserts a new binding and signals restart", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding();

      const result = state.upsertBinding(binding, {
        forceRestart: false,
        hasActiveConnection: false,
      });

      assert.equal(result.shouldRestart, true);
      assert.equal(result.shouldStop, false);
      assert.equal(result.publishSnapshot, true);
    });

    test("returns no-op for an unchanged active binding", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding();

      state.upsertBinding(binding, { forceRestart: false, hasActiveConnection: false });

      const result = state.upsertBinding(binding, {
        forceRestart: false,
        hasActiveConnection: true,
      });

      assert.equal(result.shouldRestart, false);
      assert.equal(result.shouldStop, false);
      assert.equal(result.publishSnapshot, false);
    });

    test("restarts when forceRestart is set even without config changes", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding();

      state.upsertBinding(binding, { forceRestart: false, hasActiveConnection: true });

      const result = state.upsertBinding(binding, {
        forceRestart: true,
        hasActiveConnection: true,
      });

      assert.equal(result.shouldRestart, true);
    });

    test("restarts when config changes while connected", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding();

      state.upsertBinding(binding, { forceRestart: false, hasActiveConnection: true });

      const changed = makeBinding({ channelConfig: { appId: "cli_2" } });
      const result = state.upsertBinding(changed, {
        forceRestart: false,
        hasActiveConnection: true,
      });

      assert.equal(result.shouldRestart, true);
    });

    test("signals stop and no restart for a disabled binding", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding({ enabled: false });

      const result = state.upsertBinding(binding, {
        forceRestart: false,
        hasActiveConnection: true,
      });

      assert.equal(result.shouldStop, true);
      assert.equal(result.shouldRestart, false);
    });

    test("resets idle status after a restart-inducing upsert", () => {
      const state = new RuntimeOwnershipState();
      const binding = makeBinding();

      state.upsertBinding(binding, { forceRestart: false, hasActiveConnection: false });
      state.markConnected(binding.id);

      const changed = makeBinding({ agentId: "agent-2" });
      state.upsertBinding(changed, { forceRestart: false, hasActiveConnection: true });

      const owned = state.getOwnedBinding(binding.id);
      assert.equal(owned?.status.status, "idle");
      assert.equal(owned?.reconnectAttempt, 0);
    });
  });

  describe("releaseBinding", () => {
    test("returns true and removes an owned binding", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      const released = state.releaseBinding("binding-1");

      assert.equal(released, true);
      assert.equal(state.getOwnedBinding("binding-1"), undefined);
    });

    test("returns false when the binding was not owned", () => {
      const state = new RuntimeOwnershipState();
      const released = state.releaseBinding("unknown");
      assert.equal(released, false);
    });
  });

  describe("detachBinding", () => {
    test("removes a binding from ownership state", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      state.detachBinding("binding-1");

      assert.equal(state.getOwnedBinding("binding-1"), undefined);
    });
  });

  describe("status lifecycle", () => {
    test("markIdle resets reconnect attempt and status", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      state.markDisconnected("binding-1");
      state.markIdle("binding-1");

      const owned = state.getOwnedBinding("binding-1");
      assert.equal(owned?.status.status, "idle");
      assert.equal(owned?.reconnectAttempt, 0);
    });

    test("markConnecting sets connecting status", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      state.markConnecting("binding-1");

      const status = state.listConnectionStatuses()[0];
      assert.equal(status?.status, "connecting");
    });

    test("markConnected sets connected status and resets reconnect attempts", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      state.markDisconnected("binding-1");
      state.markConnected("binding-1");

      const owned = state.getOwnedBinding("binding-1");
      assert.equal(owned?.status.status, "connected");
      assert.equal(owned?.reconnectAttempt, 0);
    });

    test("markDisconnected increments reconnect attempt and returns delay", () => {
      const state = new RuntimeOwnershipState({
        reconnectPolicy: {
          next: (attempt) => ({ attempt, delayMs: attempt * 100 }),
        },
      });
      state.attachBinding(makeBinding());

      const decision = state.markDisconnected("binding-1");

      assert.equal(decision.attempt, 1);
      assert.equal(decision.delayMs, 100);

      const owned = state.getOwnedBinding("binding-1");
      assert.equal(owned?.status.status, "disconnected");
      assert.equal(owned?.reconnectAttempt, 1);
    });

    test("markError increments reconnect attempt and stores error string", () => {
      const state = new RuntimeOwnershipState({
        reconnectPolicy: {
          next: (attempt) => ({ attempt, delayMs: attempt * 50 }),
        },
      });
      state.attachBinding(makeBinding());

      const decision = state.markError("binding-1", new Error("ECONNREFUSED"));

      assert.equal(decision.attempt, 1);

      const status = state.listConnectionStatuses()[0];
      assert.equal(status?.status, "error");
      assert.ok(status?.error?.includes("ECONNREFUSED"));
    });

    test("reconnect attempts accumulate across multiple failures", () => {
      const state = new RuntimeOwnershipState({
        reconnectPolicy: {
          next: (attempt) => ({ attempt, delayMs: attempt * 100 }),
        },
      });
      state.attachBinding(makeBinding());

      state.markDisconnected("binding-1");
      state.markDisconnected("binding-1");
      const third = state.markDisconnected("binding-1");

      assert.equal(third.attempt, 3);
    });
  });

  describe("listConnectionStatuses", () => {
    test("returns statuses sorted by bindingId", () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding({ id: "zzz" }));
      state.attachBinding(makeBinding({ id: "aaa" }));

      const statuses = state.listConnectionStatuses();
      assert.equal(statuses[0]?.bindingId, "aaa");
      assert.equal(statuses[1]?.bindingId, "zzz");
    });

    test("returns empty array when no bindings are owned", () => {
      const state = new RuntimeOwnershipState();
      assert.deepEqual(state.listConnectionStatuses(), []);
    });
  });

  describe("scheduleReconnect / clearReconnect", () => {
    test("scheduleReconnect invokes callback after the delay", async () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      let called = false;
      state.scheduleReconnect("binding-1", 5, () => {
        called = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(called, true);
    });

    test("clearReconnect cancels a pending reconnect callback", async () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      let called = false;
      state.scheduleReconnect("binding-1", 30, () => {
        called = true;
      });

      state.clearReconnect("binding-1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(called, false);
    });

    test("scheduling a second reconnect cancels the first one", async () => {
      const state = new RuntimeOwnershipState();
      state.attachBinding(makeBinding());

      const fired: number[] = [];
      state.scheduleReconnect("binding-1", 100, () => { fired.push(1); });
      state.scheduleReconnect("binding-1", 5, () => { fired.push(2); });

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(fired, [2]);
    });
  });
});
