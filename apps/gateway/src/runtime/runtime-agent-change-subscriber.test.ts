import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentConfigAggregate,
  type AgentConfigRepository,
  type AgentConfigSnapshot,
} from "@agent-relay/domain";

import { LocalRuntimeEventBus } from "./event-transport/local-runtime-event-bus.js";
import { RuntimeAgentChangeSubscriber } from "./runtime-agent-change-subscriber.js";

describe("RuntimeAgentChangeSubscriber", () => {
  test("reloads changed agents and applies them to local runtime assignments", async () => {
    const bus = new LocalRuntimeEventBus();
    const applied: AgentConfigSnapshot[] = [];
    const subscriber = new RuntimeAgentChangeSubscriber(
      bus,
      createAgentRepo(),
      {
        applyAgentUpsert: async (agent: AgentConfigSnapshot) => {
          applied.push(agent);
        },
      } as never,
    );

    await subscriber.start();
    await bus.broadcast({ type: "AgentChanged", agentId: "agent-1" });
    await subscriber.stop();

    assert.deepEqual(
      applied.map((agent) => [agent.id, agent.config]),
      [["agent-1", { url: "http://updated-agent.test" }]],
    );
  });
});

function createAgentRepo(): AgentConfigRepository {
  return {
    findById: async (id) =>
      id === "agent-1"
        ? AgentConfigAggregate.fromSnapshot({
            id: "agent-1",
            name: "Agent One",
            protocol: "a2a",
            config: { url: "http://updated-agent.test" },
            createdAt: "2026-05-07T08:00:00.000Z",
          })
        : null,
    findAll: async () => [],
    save: async () => {},
  };
}
