import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AgentConfigAggregate,
  type AgentConfigRepository,
  ChannelBindingAggregate,
  type ChannelBindingRepository,
} from "@a2a-channels/domain";

import type { RuntimeEventBus } from "../runtime/event-transport/runtime-event-bus.js";
import { ChannelBindingService } from "./channel-binding-service.js";
import type { AccountIdGenerator } from "./account-id-generator.js";

const agent = AgentConfigAggregate.register({
  id: "agent-1",
  name: "Echo",
  url: "http://localhost:3001",
});

const eventBus: RuntimeEventBus = {
  broadcast: async () => {},
  sendDirected: async () => {},
  onBroadcast: () => () => {},
  onDirectedCommand: () => () => {},
};

const accountIds = {
  resolve: (accountId: string | undefined) => accountId?.trim() || "generated",
  normalize: (accountId: string | undefined) => accountId?.trim() || undefined,
  generate: () => "generated",
} as AccountIdGenerator;

describe("ChannelBindingService", () => {
  test("generates an account ID when creating a binding without one", async () => {
    let saved: ChannelBindingAggregate | undefined;
    const repo: ChannelBindingRepository = {
      findById: async () => null,
      findAll: async () => [],
      findEnabled: async () => null,
      findByAgentId: async () => [],
      findByChannelAccount: async () => null,
      save: async (aggregate) => {
        saved = aggregate;
      },
    };
    const agentRepo: AgentConfigRepository = {
      findById: async (id) => (id === agent.id ? agent : null),
      findByUrl: async () => null,
      findAll: async () => [agent.snapshot()],
      save: async () => {},
    };
    const service = new ChannelBindingService(
      repo,
      agentRepo,
      eventBus,
      accountIds,
    );

    const binding = await service.create({
      name: "WeChat",
      channelType: "wechat",
      channelConfig: {},
      agentId: agent.id,
      enabled: true,
    });

    assert.equal(binding.accountId, "generated");
    assert.equal(saved?.snapshot().accountId, "generated");
  });
});
