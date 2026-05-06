import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AgentConfigAggregate,
  type AgentConfigRepository,
  type ChannelBindingRepository,
} from "@agent-relay/domain";

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
      name: "a2a-agent",
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
      name: "a2a-agent",
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
      config: { transport: "stdio", command: "npx", args: ["@codex/agent"] },
    });

    assert.equal(updated?.protocol, "acp");
    assert.deepEqual(updated?.config, {
      transport: "stdio",
      command: "npx",
      args: ["@codex/agent"],
    });
  });

  test("rejects agent names that cannot be used as folder names", async () => {
    const aggregate = AgentConfigAggregate.register({
      id: "agent-1",
      name: "a2a-agent",
      protocol: "a2a",
      config: { url: "http://localhost:3001" },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    await assert.rejects(
      () =>
        service.register({
          name: "Invalid Agent",
          protocol: "acp",
          config: { transport: "stdio", command: "npx" },
        }),
      InvalidAgentConfigError,
    );
    await assert.rejects(
      () => service.update(aggregate.id, { name: "../agent" }),
      InvalidAgentConfigError,
    );
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
