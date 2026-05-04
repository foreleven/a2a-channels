import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentClient,
  type AgentTransportFactory,
} from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentClientRegistry } from "./agent-client-registry.js";
import { AgentClientFactory } from "./agent-clients.js";

const agent: AgentConfigSnapshot = {
  id: "agent-1",
  name: "Agent One",
  protocol: "a2a",
  config: { url: "http://agent-1" },
  createdAt: new Date().toISOString(),
};

const testTransport: AgentTransportFactory = {
  protocol: "a2a",
  create: (config) => ({
    protocol: "a2a",
    displayTarget: "url" in config ? config.url : "",
    send: async () => ({ text: "ok" }),
  }),
};

describe("AgentClientRegistry", () => {
  test("require throws when the agent client has not been registered", () => {
    const registry = new AgentClientRegistry(
      new AgentClientFactory([testTransport]),
    );

    assert.throws(
      () => registry.require(agent),
      /Agent client for agent-1 is not registered/,
    );
  });

  test("upsert registers a stable client instance", async () => {
    const registry = new AgentClientRegistry(
      new AgentClientFactory([testTransport]),
    );

    await registry.upsert(agent);
    const firstClient = registry.require(agent);

    assert.ok(firstClient instanceof AgentClient);

    await registry.upsert(agent, agent);
    const secondClient = registry.require(agent);

    assert.strictEqual(firstClient, secondClient);
  });
});
