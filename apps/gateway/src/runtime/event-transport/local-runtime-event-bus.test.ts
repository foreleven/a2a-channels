import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { LocalRuntimeEventBus } from "./local-runtime-event-bus.js";

describe("LocalRuntimeEventBus", () => {
  test("onBroadcast handler receives a broadcast event", async () => {
    const bus = new LocalRuntimeEventBus();
    const received: string[] = [];

    bus.onBroadcast((event) => received.push(event.type));
    await bus.broadcast({ type: "NodeJoined", nodeId: "node-1" });

    assert.deepEqual(received, ["NodeJoined"]);
  });

  test("onBroadcast delivers all event fields", async () => {
    const bus = new LocalRuntimeEventBus();
    const events: Array<{ type: string; nodeId?: string; bindingId?: string }> = [];

    bus.onBroadcast((event) => events.push({ ...event }));
    await bus.broadcast({ type: "BindingChanged", bindingId: "b-1" });

    assert.deepEqual(events, [{ type: "BindingChanged", bindingId: "b-1" }]);
  });

  test("multiple broadcast subscribers all receive the same event", async () => {
    const bus = new LocalRuntimeEventBus();
    const received1: string[] = [];
    const received2: string[] = [];

    bus.onBroadcast((e) => received1.push(e.type));
    bus.onBroadcast((e) => received2.push(e.type));
    await bus.broadcast({ type: "NodeLeft", nodeId: "node-x" });

    assert.deepEqual(received1, ["NodeLeft"]);
    assert.deepEqual(received2, ["NodeLeft"]);
  });

  test("unsubscribing a broadcast listener stops future deliveries", async () => {
    const bus = new LocalRuntimeEventBus();
    const received: string[] = [];

    const unsubscribe = bus.onBroadcast((e) => received.push(e.type));
    await bus.broadcast({ type: "NodeJoined", nodeId: "n-1" });

    unsubscribe();
    await bus.broadcast({ type: "NodeJoined", nodeId: "n-2" });

    assert.deepEqual(received, ["NodeJoined"]);
  });

  test("onDirectedCommand handler receives a directed command", async () => {
    const bus = new LocalRuntimeEventBus();
    const received: string[] = [];

    bus.onDirectedCommand((cmd) => received.push(cmd.type));
    await bus.sendDirected("node-1", { type: "AttachBinding", bindingId: "b-1" });

    assert.deepEqual(received, ["AttachBinding"]);
  });

  test("sendDirected ignores nodeId in single-instance mode", async () => {
    const bus = new LocalRuntimeEventBus();
    const ids: string[] = [];

    bus.onDirectedCommand((cmd) => ids.push(cmd.bindingId));
    await bus.sendDirected("any-node-id", { type: "DetachBinding", bindingId: "b-99" });
    await bus.sendDirected("__local__", { type: "DetachBinding", bindingId: "b-100" });

    assert.deepEqual(ids, ["b-99", "b-100"]);
  });

  test("unsubscribing a directed command listener stops future deliveries", async () => {
    const bus = new LocalRuntimeEventBus();
    const received: string[] = [];

    const unsubscribe = bus.onDirectedCommand((cmd) => received.push(cmd.type));
    await bus.sendDirected("n", { type: "RefreshBinding", bindingId: "b-1" });

    unsubscribe();
    await bus.sendDirected("n", { type: "RefreshBinding", bindingId: "b-2" });

    assert.deepEqual(received, ["RefreshBinding"]);
  });

  test("broadcast and directed commands are independent channels", async () => {
    const bus = new LocalRuntimeEventBus();
    const broadcasts: string[] = [];
    const commands: string[] = [];

    bus.onBroadcast((e) => broadcasts.push(e.type));
    bus.onDirectedCommand((c) => commands.push(c.type));

    await bus.broadcast({ type: "AgentChanged", agentId: "a-1" });
    await bus.sendDirected("n", { type: "AttachBinding", bindingId: "b-1" });

    assert.deepEqual(broadcasts, ["AgentChanged"]);
    assert.deepEqual(commands, ["AttachBinding"]);
  });
});
