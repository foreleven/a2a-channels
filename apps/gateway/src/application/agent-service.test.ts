import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AgentConfigAggregate,
  type AgentConfigRepository,
  type ChannelBindingRepository,
} from "@agent-relay/domain";
import type { WsTunnelAgentConfig } from "@agent-relay/domain";

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

  // ---------------------------------------------------------------------------
  // ws-tunnel protocol
  // ---------------------------------------------------------------------------

  test("auto-generates relayToken when registering a ws-tunnel agent", async () => {
    const saved: AgentConfigAggregate[] = [];
    const repo: AgentConfigRepository = {
      findById: async () => null,
      findAll: async () => [],
      save: async (agg) => { saved.push(agg); },
    };
    const service = new AgentService(repo, createBindingRepo(), eventBus);

    const result = await service.register({
      name: "my-relay-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        relayToken: "",            // empty – should be replaced by service
        executor: { type: "claude-code" },
      },
    });

    assert.equal(result.protocol, "ws-tunnel");
    const cfg = result.config as WsTunnelAgentConfig;
    assert.equal(typeof cfg.relayToken, "string");
    assert.ok(cfg.relayToken.length > 0, "relayToken must be non-empty");
    assert.notEqual(cfg.relayToken, "", "relayToken must not be the placeholder");
  });

  test("preserves existing relayToken when updating a ws-tunnel agent", async () => {
    const originalToken = "original-secret-token";
    const aggregate = AgentConfigAggregate.register({
      id: "relay-agent-1",
      name: "relay-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        relayToken: originalToken,
        executor: { type: "claude-code", model: "claude-opus-4-5" },
      },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    const updated = await service.update(aggregate.id, {
      config: {
        transport: "ws-tunnel",
        relayToken: "ignored-new-token",   // must not overwrite stored token
        executor: { type: "claude-code", model: "claude-sonnet-4-5" },
      },
    });

    assert.ok(updated, "update should succeed");
    const cfg = updated.config as WsTunnelAgentConfig;
    assert.equal(
      cfg.relayToken,
      originalToken,
      "relayToken must be preserved across updates",
    );
    assert.equal(cfg.executor.model, "claude-sonnet-4-5");
  });

  test("regenerateRelayToken replaces the token and returns the snapshot", async () => {
    const originalToken = "original-secret-token";
    const aggregate = AgentConfigAggregate.register({
      id: "relay-agent-2",
      name: "relay-agent-2",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        relayToken: originalToken,
        executor: { type: "claude-code" },
      },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    const updated = await service.regenerateRelayToken(aggregate.id);

    assert.ok(updated, "result should be non-null");
    const cfg = updated.config as WsTunnelAgentConfig;
    assert.notEqual(cfg.relayToken, originalToken, "token must change");
    assert.equal(typeof cfg.relayToken, "string");
    assert.ok(cfg.relayToken.length > 0);
  });

  test("regenerateRelayToken returns null for a non-existent agent", async () => {
    const aggregate = AgentConfigAggregate.register({
      id: "relay-agent-3",
      name: "relay-agent-3",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        relayToken: "tok",
        executor: { type: "claude-code" },
      },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    const result = await service.regenerateRelayToken("no-such-id");
    assert.equal(result, null);
  });

  test("regenerateRelayToken throws InvalidAgentConfigError for non-ws-tunnel agent", async () => {
    const aggregate = AgentConfigAggregate.register({
      id: "a2a-agent-5",
      name: "a2a-agent-5",
      protocol: "a2a",
      config: { url: "http://localhost:3001" },
    });
    const service = new AgentService(
      createAgentRepo(aggregate),
      createBindingRepo(),
      eventBus,
    );

    await assert.rejects(
      () => service.regenerateRelayToken(aggregate.id),
      InvalidAgentConfigError,
    );
  });
});

function createAgentRepo(
  aggregate: AgentConfigAggregate,
): AgentConfigRepository {
  // Keep the aggregate mutable so that update/regenerate tests see changes.
  const map = new Map([[aggregate.id, aggregate]]);
  return {
    findById: async (id) => map.get(id) ?? null,
    findAll: async () => [...map.values()].map((a) => a.snapshot()),
    save: async (agg) => { map.set(agg.id, agg); },
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
