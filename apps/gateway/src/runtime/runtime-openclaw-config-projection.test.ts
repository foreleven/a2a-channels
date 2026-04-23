import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { AgentConfig, AgentTransport, ChannelBinding } from "@a2a-channels/core";

import { AgentClientFactory } from "./agent-clients.js";
import { AgentClientRegistry } from "./agent-client-registry.js";
import { OpenClawConfigBuilder } from "./openclaw-config.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";
import { TransportRegistryAssembler } from "./transport-registry-assembler.js";

const agent: AgentConfig = {
  id: "agent-1",
  name: "Agent One",
  url: "http://agent-1",
  protocol: "a2a",
  createdAt: new Date().toISOString(),
};

const binding: ChannelBinding = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: { appId: "cli_1", appSecret: "sec_1" },
  agentId: agent.id,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const testTransport: AgentTransport = {
  protocol: "a2a",
  send: async () => ({ text: "ok" }),
};

describe("RuntimeOpenClawConfigProjection", () => {
  test("rebuild reflects the current bindings and registered agents", async () => {
    const agentRegistry = new RuntimeAgentRegistry(
      new AgentClientRegistry(
        new AgentClientFactory(new TransportRegistryAssembler([testTransport])),
      ),
    );
    const projection = new RuntimeOpenClawConfigProjection(
      new OpenClawConfigBuilder(),
      agentRegistry,
      {
        listBindings: () => [binding],
      } as never,
    );

    await agentRegistry.upsertAgent(agent);
    projection.rebuild();

    assert.equal(
      projection.getConfig().channels?.feishu?.bindingId,
      binding.id,
    );
    assert.equal(
      projection.getConfig().channels?.feishu?.agentUrl,
      agent.url,
    );
  });
});
