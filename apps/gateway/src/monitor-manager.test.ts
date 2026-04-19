import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  ChannelAccountRunner,
  ChannelBinding,
  ChannelProvider,
} from "@a2a-channels/core";

import { MonitorManager } from "./monitor-manager.js";

function binding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    id: "binding-1",
    name: "Test Binding",
    channelType: "feishu",
    accountId: "default",
    channelConfig: {},
    agentUrl: "http://agent:3001",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

class FakeRunner implements ChannelAccountRunner {
  aborted = false;

  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return;
    }

    return new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          resolve();
        },
        { once: true },
      );
    });
  }
}

class FakeProvider implements ChannelProvider {
  readonly channelType = "feishu";
  readonly runners: FakeRunner[] = [];
  readonly bindings: ChannelBinding[] = [];

  supports(channelType: string): boolean {
    return channelType === this.channelType;
  }

  createAccountRunner(binding: ChannelBinding): ChannelAccountRunner {
    const runner = new FakeRunner();
    this.bindings.push(binding);
    this.runners.push(runner);
    return runner;
  }
}

describe("MonitorManager", () => {
  test("syncMonitors starts one monitor per enabled binding id", async () => {
    const provider = new FakeProvider();
    const bindings = [
      binding({ id: "binding-1", accountId: "same" }),
      binding({ id: "binding-2", accountId: "other" }),
      binding({ id: "binding-3", enabled: false }),
    ];
    const manager = new MonitorManager([provider], () => bindings);

    await manager.syncMonitors();

    assert.equal(provider.runners.length, 2);
    assert.deepEqual(
      provider.bindings.map((b) => b.id),
      ["binding-1", "binding-2"],
    );
    await manager.stopAllMonitors();
  });

  test("syncMonitors keeps same-account bindings separate by id", async () => {
    const provider = new FakeProvider();
    const bindings = [
      binding({ id: "binding-1", accountId: "shared" }),
      binding({ id: "binding-2", accountId: "shared" }),
    ];
    const manager = new MonitorManager([provider], () => bindings);

    await manager.syncMonitors();

    assert.equal(provider.runners.length, 2);
    assert.deepEqual(
      provider.bindings.map((b) => b.id),
      ["binding-1", "binding-2"],
    );
    await manager.stopAllMonitors();
  });

  test("syncMonitors stops removed or disabled binding ids only", async () => {
    const provider = new FakeProvider();
    let bindings = [
      binding({ id: "binding-1" }),
      binding({ id: "binding-2", accountId: "other" }),
    ];
    const manager = new MonitorManager([provider], () => bindings);

    await manager.syncMonitors();
    const [firstRunner, secondRunner] = provider.runners;

    bindings = [binding({ id: "binding-2", accountId: "other" })];
    await manager.syncMonitors();

    assert.equal(firstRunner?.aborted, true);
    assert.equal(secondRunner?.aborted, false);
    assert.equal(provider.runners.length, 2);
    await manager.stopAllMonitors();
  });

  test("restartMonitor aborts the previous runner and starts the updated binding", async () => {
    const provider = new FakeProvider();
    const manager = new MonitorManager([provider], () => []);

    await manager.restartMonitor(binding({ id: "binding-1", agentUrl: "http://old" }));
    const firstRunner = provider.runners[0]!;
    await manager.restartMonitor(binding({ id: "binding-1", agentUrl: "http://new" }));

    assert.equal(firstRunner.aborted, true);
    assert.equal(provider.runners.length, 2);
    assert.equal(provider.bindings[1]?.agentUrl, "http://new");
    await manager.stopAllMonitors();
  });

  test("restartMonitor stops disabled bindings without starting a new runner", async () => {
    const provider = new FakeProvider();
    const manager = new MonitorManager([provider], () => []);

    await manager.restartMonitor(binding({ id: "binding-1" }));
    const firstRunner = provider.runners[0]!;
    await manager.restartMonitor(binding({ id: "binding-1", enabled: false }));

    assert.equal(firstRunner.aborted, true);
    assert.equal(provider.runners.length, 1);
  });
});
