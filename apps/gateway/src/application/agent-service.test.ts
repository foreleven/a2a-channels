import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AgentConfigAggregate,
  type AgentConfigRepository,
  type ChannelBindingRepository,
} from "@a2a-channels/domain";

import type { RuntimeEventBus } from "../runtime/event-transport/runtime-event-bus.js";
import { AgentService, InvalidAgentConfigError } from "./agent-service.js";

const eventBus: RuntimeEventBus = {
  broadcast: async () => {},
  sendDirected: async () => {},
  onBroadcast: () => () => {},
  onDirectedCommand: () => () => {},
};

describe("AgentService", () => {
  test("rejects protocol-only updates that would desynchronize config", async () => {
    const aggregate = AgentConfigAggregate.register({
      id: "agent-1",
      name: "A2A Agent",
      protocol: "a2a",
      config: { url: "http://localhost:3001" },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    await assert.rejects(
      () => service.update(aggregate.id, { protocol: "acp" }),
      InvalidAgentConfigError,
    );
  });

  test("accepts ACP protocol changes when config is updated together", async () => {
    const aggregate = AgentConfigAggregate.register({
      id: "agent-1",
      name: "A2A Agent",
      protocol: "a2a",
      config: { url: "http://localhost:3001" },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    const updated = await service.update(aggregate.id, {
      protocol: "acp",
      config: { transport: "rest", url: "http://localhost:8000" },
    });

    assert.equal(updated?.protocol, "acp");
    assert.deepEqual(updated?.config, {
      transport: "rest",
      url: "http://localhost:8000",
    });
  });
});

function createAgentRepo(
  aggregate: AgentConfigAggregate,
): AgentConfigRepository {
  return {
    findById: async (id) => (id === aggregate.id ? aggregate : null),
    findAll: async () => [aggregate.snapshot()],
    save: async () => {},
  };
}

function createBindingRepo(): ChannelBindingRepository {
  return {
    findById: async () => null,
    findAll: async () => [],
    findEnabled: async () => null,
    findByAgentId: async () => [],
    findByChannelAccount: async () => null,
    save: async () => {},
  };
}
