import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentClient,
  type AgentTransportFactory,
} from "@agent-relay/agent-transport";
import type { AgentConfigSnapshot } from "@agent-relay/domain";

import { AgentClientRegistry } from "./agent-client-registry.js";
import { AgentClientFactory } from "./agent-clients.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";

function makeAgent(
  overrides: Partial<AgentConfigSnapshot> = {},
): AgentConfigSnapshot {
  return {
    id: "agent-1",
    name: "my-agent",
    protocol: "a2a",
    config: { url: "http://agent-1" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const testTransport: AgentTransportFactory = {
  protocol: "a2a",
  create: () => ({
    protocol: "a2a",
    send: async () => ({ text: "ok" }),
  }),
};

function createRegistry(): RuntimeAgentRegistry {
  const clientFactory = new AgentClientFactory([testTransport]);
  const clientRegistry = new AgentClientRegistry(clientFactory);
  return new RuntimeAgentRegistry(clientRegistry);
}

describe("RuntimeAgentRegistry", () => {
  describe("getAgent", () => {
    test("returns undefined before an agent is upserted", () => {
      const registry = createRegistry();
      assert.equal(registry.getAgent("agent-1"), undefined);
    });

    test("returns the snapshot after upsert", async () => {
      const registry = createRegistry();
      const agent = makeAgent();

      await registry.upsertAgent(agent);

      const retrieved = registry.getAgent("agent-1");
      assert.ok(retrieved !== undefined);
      assert.equal(retrieved?.id, "agent-1");
      assert.equal(retrieved?.name, "my-agent");
    });
  });

  describe("upsertAgent", () => {
    test("registers a transport client accessible via getAgentClient", async () => {
      const registry = createRegistry();
      const agent = makeAgent();

      await registry.upsertAgent(agent);
      const client = await registry.getAgentClient("agent-1");

      assert.ok(client instanceof AgentClient);
    });

    test("stable client is returned on re-upsert with the same config", async () => {
      const registry = createRegistry();
      const agent = makeAgent();

      await registry.upsertAgent(agent);
      const first = await registry.getAgentClient("agent-1");

      await registry.upsertAgent(agent);
      const second = await registry.getAgentClient("agent-1");

      assert.strictEqual(first, second);
    });

    test("multiple agents can coexist in the registry", async () => {
      const registry = createRegistry();

      await registry.upsertAgent(makeAgent({ id: "a-1" }));
      await registry.upsertAgent(makeAgent({ id: "a-2", name: "my-other-agent" }));

      assert.ok(registry.getAgent("a-1") !== undefined);
      assert.ok(registry.getAgent("a-2") !== undefined);
    });
  });

  describe("deleteAgent", () => {
    test("removes the agent snapshot", async () => {
      const registry = createRegistry();
      await registry.upsertAgent(makeAgent());

      await registry.deleteAgent("agent-1");

      assert.equal(registry.getAgent("agent-1"), undefined);
    });

    test("is a no-op for an agent that does not exist", async () => {
      const registry = createRegistry();
      await assert.doesNotReject(() => registry.deleteAgent("nonexistent"));
    });
  });

  describe("listAgents", () => {
    test("returns agents sorted by createdAt", async () => {
      const registry = createRegistry();
      const older = makeAgent({ id: "a-old", createdAt: "2026-01-01T00:00:00.000Z" });
      const newer = makeAgent({ id: "a-new", name: "my-agent-2", createdAt: "2026-06-01T00:00:00.000Z" });

      await registry.upsertAgent(newer);
      await registry.upsertAgent(older);

      const list = registry.listAgents();
      assert.equal(list[0]?.id, "a-old");
      assert.equal(list[1]?.id, "a-new");
    });

    test("returns an empty array when no agents are registered", () => {
      const registry = createRegistry();
      assert.deepEqual(registry.listAgents(), []);
    });
  });

  describe("getAgentClient", () => {
    test("throws when the agent does not exist", async () => {
      const registry = createRegistry();
      await assert.rejects(
        () => registry.getAgentClient("missing"),
        /Agent missing not found/,
      );
    });
  });

  describe("snapshotAgentsById", () => {
    test("returns a read-only copy of the agent map", async () => {
      const registry = createRegistry();
      const agent = makeAgent();
      await registry.upsertAgent(agent);

      const snapshot = registry.snapshotAgentsById();
      assert.ok(snapshot.has("agent-1"));
      assert.equal(snapshot.get("agent-1")?.id, "agent-1");
    });
  });

  describe("stopAllClients", () => {
    test("does not throw when called with no registered clients", async () => {
      const registry = createRegistry();
      await assert.doesNotReject(() => registry.stopAllClients());
    });

    test("removes all clients after stopping", async () => {
      const registry = createRegistry();
      await registry.upsertAgent(makeAgent({ id: "a-1" }));
      await registry.upsertAgent(makeAgent({ id: "a-2", name: "my-other-agent" }));

      await registry.stopAllClients();

      await assert.rejects(
        () => registry.getAgentClient("a-1"),
        /not registered/,
      );
    });
  });
});
