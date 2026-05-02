import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentClient,
  type AgentTransport,
} from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentClientRegistry } from "./agent-client-registry.js";
import { AgentClientFactory } from "./agent-clients.js";

const agent: AgentConfigSnapshot = {
  id: "agent-1",
  name: "Agent One",
  url: "http://agent-1",
  protocol: "a2a",
  createdAt: new Date().toISOString(),
};

const testTransport: AgentTransport = {
  protocol: "a2a",
  send: async () => ({ text: "ok" }),
};

describe("AgentClientRegistry", () => {
  test("require throws when the agent client has not been registered", () => {
    const registry = new AgentClientRegistry(
      new AgentClientFactory([testTransport]),
    );

    assert.throws(
      () => registry.require(agent),
      /Agent client for http:\/\/agent-1 is not registered/,
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
