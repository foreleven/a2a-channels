import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DomainEventBus } from "../infra/domain-event-bus.js";
import { DomainEventBridge } from "./domain-event-bridge.js";
import { LocalRuntimeEventBus } from "./event-transport/local-runtime-event-bus.js";

describe("DomainEventBridge", () => {
  test("start is idempotent and stop removes listeners", () => {
    const domainBus = new DomainEventBus();
    const runtimeBus = new LocalRuntimeEventBus();
    const bridge = new DomainEventBridge(domainBus, runtimeBus);
    const broadcasts: string[] = [];

    runtimeBus.onBroadcast((event) => broadcasts.push(event.type));

    bridge.start("node-a");
    bridge.start("node-a");
    domainBus.publish({
      eventType: "ChannelBindingCreated.v1",
      bindingId: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: {},
      agentId: "agent-1",
      enabled: true,
      occurredAt: new Date().toISOString(),
    });

    bridge.stop();
    domainBus.publish({
      eventType: "ChannelBindingUpdated.v1",
      bindingId: "binding-1",
      changes: { enabled: false },
      occurredAt: new Date().toISOString(),
    });

    assert.deepEqual(broadcasts, ["NodeJoined", "BindingChanged"]);
  });
});
