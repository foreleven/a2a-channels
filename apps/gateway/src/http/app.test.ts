import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Container } from "inversify";
import type { AgentConfigSnapshot } from "../application/agent-service.js";
import {
  AgentService,
  ReferencedAgentError,
} from "../application/agent-service.js";
import type { ChannelBindingSnapshot } from "../application/channel-binding-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { RuntimeStatusService } from "../application/runtime-status-service.js";
import { buildGatewayContainer } from "../bootstrap/container.js";
import { GatewayApp, GatewayWebDir, HonoGatewayApp } from "./app.js";

function createHttpContainer(): Container {
  const container = buildGatewayContainer({
    corsOrigin: "http://localhost:3000",
  });
  container.rebindSync(GatewayWebDir).toConstantValue("/tmp/does-not-exist");
  return container;
}

describe("GatewayApp", () => {
  test("exposes runtime status read APIs", async () => {
    const container = createHttpContainer();
    const channelService = {
      list: async () => [{ id: "binding-1", name: "Binding" }],
      getById: async (id: string) =>
        id === "binding-1" ? { id: "binding-1", name: "Binding" } : null,
      create: async () => ({ id: "binding-2" }),
      update: async () => ({ id: "binding-1" }),
      delete: async () => true,
    };
    const agentService = {
      list: async (): Promise<AgentConfigSnapshot[]> => [
        {
          id: "agent-1",
          name: "Echo",
          protocol: "a2a",
          config: { url: "http://localhost:3001" },
          createdAt: "2026-04-21T00:00:00.000Z",
        },
      ],
      getById: async (id: string) =>
        id === "agent-1"
          ? {
              id: "agent-1",
              name: "Echo",
              protocol: "a2a",
              config: { url: "http://localhost:3001" },
              createdAt: "2026-04-21T00:00:00.000Z",
            }
          : null,
      register: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-2",
        name: "Echo 2",
        protocol: "a2a",
        config: { url: "http://localhost:3002" },
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      update: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-1",
        name: "Echo",
        protocol: "a2a",
        config: { url: "http://localhost:3001" },
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      delete: async () => true,
    };
    const runtimeStatusService = {
      getStatus: async () => ({
        mode: "local",
        currentNodeId: "local",
        generatedAt: "2026-04-21T00:00:00.000Z",
        nodes: [
          {
            nodeId: "local",
            displayName: "Gateway Node",
            mode: "local",
            lastKnownAddress: "http://localhost:7890",
            registeredAt: "2026-04-21T00:00:00.000Z",
            updatedAt: "2026-04-21T00:00:00.000Z",
            isCurrent: true,
          },
        ],
        channels: [
          {
            bindingId: "binding-1",
            mode: "local",
            ownership: "local",
            status: "connected",
            ownerNodeId: "local",
            ownerDisplayName: "Gateway Node",
            leaseHeld: true,
            updatedAt: "2026-04-21T00:00:00.000Z",
          },
        ],
      }),
    };

    container
      .rebindSync(ChannelBindingService)
      .toConstantValue(channelService as unknown as ChannelBindingService);
    container
      .rebindSync(AgentService)
      .toConstantValue(agentService as unknown as AgentService);
    container
      .rebindSync(RuntimeStatusService)
      .toConstantValue(runtimeStatusService as unknown as RuntimeStatusService);

    const app = container.get<HonoGatewayApp>(GatewayApp);

    const channelsResponse = await app.request("/api/channels");
    assert.equal(channelsResponse.status, 200);
    assert.deepEqual(await channelsResponse.json(), [
      { id: "binding-1", name: "Binding" },
    ]);

    const agentsResponse = await app.request("/api/agents");
    assert.equal(agentsResponse.status, 200);
    assert.deepEqual(await agentsResponse.json(), [
      {
        id: "agent-1",
        name: "Echo",
        protocol: "a2a",
        config: { url: "http://localhost:3001" },
        createdAt: "2026-04-21T00:00:00.000Z",
      },
    ]);

    const runtimeNodesResponse = await app.request("/api/runtime/nodes");
    assert.equal(runtimeNodesResponse.status, 200);
    assert.deepEqual(await runtimeNodesResponse.json(), [
      {
        nodeId: "local",
        displayName: "Gateway Node",
        mode: "local",
        lastKnownAddress: "http://localhost:7890",
        registeredAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
        isCurrent: true,
      },
    ]);

    const runtimeConnectionsResponse = await app.request(
      "/api/runtime/connections",
    );
    assert.equal(runtimeConnectionsResponse.status, 200);
    assert.deepEqual(await runtimeConnectionsResponse.json(), [
      {
        bindingId: "binding-1",
        mode: "local",
        ownership: "local",
        status: "connected",
        ownerNodeId: "local",
        ownerDisplayName: "Gateway Node",
        leaseHeld: true,
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);

    const runtimeStatusResponse = await app.request("/api/runtime/status");
    assert.equal(runtimeStatusResponse.status, 200);
    const runtimeStatusPayload = (await runtimeStatusResponse.json()) as {
      mode: string;
    };
    assert.equal(runtimeStatusPayload.mode, "local");
  });

  test("preserves existing mutation error handling", async () => {
    const container = createHttpContainer();
    container.rebindSync(ChannelBindingService).toConstantValue({
      list: async (): Promise<ChannelBindingSnapshot[]> => [],
      getById: async () => null,
      create: async () => {
        throw new Error("should not reach");
      },
      update: async () => null,
      delete: async () => false,
    } as unknown as ChannelBindingService);
    container.rebindSync(AgentService).toConstantValue({
      list: async (): Promise<AgentConfigSnapshot[]> => [],
      getById: async () => null,
      register: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-1",
        name: "Echo",
        protocol: "a2a",
        config: { url: "http://localhost:3001" },
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      update: async () => null,
      delete: async () => {
        throw new ReferencedAgentError("agent-1", ["binding-1"]);
      },
    } as unknown as AgentService);
    const app = container.get<HonoGatewayApp>(GatewayApp);

    const invalidChannelBody = await app.request("/api/channels", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    assert.equal(invalidChannelBody.status, 400);
    assert.deepEqual(await invalidChannelBody.json(), {
      error: "Invalid JSON body",
    });

    const missingAgentFields = await app.request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Echo" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(missingAgentFields.status, 400);
    assert.deepEqual(await missingAgentFields.json(), {
      error: "Invalid request body",
      issues: [
        {
          path: "config",
          message: "Invalid input",
        },
      ],
    });

    const invalidChannelPayload = await app.request("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        name: "Binding",
        agentId: "agent-1",
        channelConfig: "not-an-object",
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(invalidChannelPayload.status, 400);
    assert.deepEqual(await invalidChannelPayload.json(), {
      error: "Invalid request body",
      issues: [
        {
          path: "channelConfig",
          message: "Invalid input: expected record, received string",
        },
      ],
    });

    const invalidAgentPatch = await app.request("/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ protocol: 42 }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(invalidAgentPatch.status, 400);
    assert.deepEqual(await invalidAgentPatch.json(), {
      error: "Invalid request body",
      issues: [
        {
          path: "protocol",
          message: 'Invalid option: expected one of "a2a"|"acp"',
        },
      ],
    });

    const deleteReferencedAgent = await app.request("/api/agents/agent-1", {
      method: "DELETE",
    });
    assert.equal(deleteReferencedAgent.status, 409);
    assert.deepEqual(await deleteReferencedAgent.json(), {
      error: "Agent agent-1 is referenced by 1 channel binding(s)",
      bindingIds: ["binding-1"],
    });
  });
});
