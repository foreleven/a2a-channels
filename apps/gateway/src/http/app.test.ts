import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Container } from "inversify";
import type { AgentConfigSnapshot } from "../application/agent-service.js";
import {
  AgentService,
  ReferencedAgentError,
} from "../application/agent-service.js";
import type { ChannelBindingSnapshot } from "../application/channel-binding-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import {
  buildGatewayConfig,
  GatewayConfigOverrides,
  GatewayConfigService,
} from "../bootstrap/config.js";
import { GatewayApp, GatewayWebDir, HonoGatewayApp } from "./app.js";
import { AgentRoutes } from "./routes/agents.js";
import { ChannelRoutes } from "./routes/channels.js";
import { RuntimeRoutes, RuntimeStatusSourceToken } from "./routes/runtime.js";

function createHttpContainer(): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container
    .bind(GatewayConfigOverrides)
    .toConstantValue(
      buildGatewayConfig({ corsOrigin: "http://localhost:3000" }),
    );
  container.bind(GatewayConfigService).toSelf().inSingletonScope();
  container.bind(GatewayWebDir).toConstantValue("/tmp/does-not-exist");
  container.bind(ChannelRoutes).toSelf().inSingletonScope();
  container.bind(AgentRoutes).toSelf().inSingletonScope();
  container.bind(RuntimeRoutes).toSelf().inSingletonScope();
  container.bind(HonoGatewayApp).toSelf().inSingletonScope();
  container.bind(GatewayApp).toService(HonoGatewayApp);
  return container;
}

describe("GatewayApp", () => {
  test("registers runtime nodes and connections routes against runtime reader", async () => {
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
          url: "http://localhost:3001",
          protocol: "a2a",
          createdAt: "2026-04-21T00:00:00.000Z",
        },
      ],
      getById: async (id: string) =>
        id === "agent-1"
          ? {
              id: "agent-1",
              name: "Echo",
              url: "http://localhost:3001",
              protocol: "a2a",
              createdAt: "2026-04-21T00:00:00.000Z",
            }
          : null,
      register: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-2",
        name: "Echo 2",
        url: "http://localhost:3002",
        protocol: "a2a",
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      update: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-1",
        name: "Echo",
        url: "http://localhost:3001",
        protocol: "a2a",
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      delete: async () => true,
    };

    container
      .bind(ChannelBindingService)
      .toConstantValue(channelService as unknown as ChannelBindingService);
    container
      .bind(AgentService)
      .toConstantValue(agentService as unknown as AgentService);
    container.bind(RuntimeStatusSourceToken).toConstantValue({
      listNodes: async () => [
        {
          nodeId: "node-a",
          displayName: "Gateway Node A",
          mode: "local",
          schedulerRole: "local",
          lastKnownAddress: "http://127.0.0.1:7890",
          lifecycle: "ready",
          lastHeartbeatAt: "2026-04-21T00:00:00.000Z",
          lastError: null,
          bindingCount: 1,
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      ],
      listConnections: async () => [
        {
          bindingId: "binding-1",
          bindingName: "Binding",
          channelType: "feishu",
          accountId: "default",
          agentId: "agent-1",
          ownerNodeId: "node-a",
          status: "connected",
          agentUrl: "http://localhost:3001",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      ],
    });

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
        url: "http://localhost:3001",
        protocol: "a2a",
        createdAt: "2026-04-21T00:00:00.000Z",
      },
    ]);

    const runtimeNodesResponse = await app.request("/api/runtime/nodes");
    assert.equal(runtimeNodesResponse.status, 200);
    assert.deepEqual(await runtimeNodesResponse.json(), [
      {
        nodeId: "node-a",
        displayName: "Gateway Node A",
        mode: "local",
        schedulerRole: "local",
        lastKnownAddress: "http://127.0.0.1:7890",
        lifecycle: "ready",
        lastHeartbeatAt: "2026-04-21T00:00:00.000Z",
        lastError: null,
        bindingCount: 1,
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);

    const runtimeConnectionsResponse = await app.request(
      "/api/runtime/connections",
    );
    assert.equal(runtimeConnectionsResponse.status, 200);
    assert.deepEqual(await runtimeConnectionsResponse.json(), [
      {
        bindingId: "binding-1",
        bindingName: "Binding",
        channelType: "feishu",
        accountId: "default",
        agentId: "agent-1",
        ownerNodeId: "node-a",
        status: "connected",
        agentUrl: "http://localhost:3001",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);
  });

  test("registers runtime nodes route without breaking relay-style runtime source", async () => {
    const container = createHttpContainer();
    container.bind(ChannelBindingService).toConstantValue({
      list: async (): Promise<ChannelBindingSnapshot[]> => [],
      getById: async () => null,
      create: async () => ({ id: "binding-2" }),
      update: async () => null,
      delete: async () => false,
    } as unknown as ChannelBindingService);
    container.bind(AgentService).toConstantValue({
      list: async (): Promise<AgentConfigSnapshot[]> => [],
      getById: async () => null,
      register: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-1",
        name: "Echo",
        url: "http://localhost:3001",
        protocol: "a2a",
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      update: async () => null,
      delete: async () => false,
    } as unknown as AgentService);
    container.bind(RuntimeStatusSourceToken).toConstantValue({
      listConnectionStatuses: () => [
        {
          bindingId: "binding-1",
          status: "connected",
          agentUrl: "http://localhost:3001",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      ],
    });

    const app = container.get<HonoGatewayApp>(GatewayApp);

    const runtimeNodesResponse = await app.request("/api/runtime/nodes");
    assert.equal(runtimeNodesResponse.status, 200);
    assert.deepEqual(await runtimeNodesResponse.json(), []);

    const runtimeConnectionsResponse = await app.request(
      "/api/runtime/connections",
    );
    assert.equal(runtimeConnectionsResponse.status, 200);
    assert.deepEqual(await runtimeConnectionsResponse.json(), [
      {
        bindingId: "binding-1",
        status: "connected",
        agentUrl: "http://localhost:3001",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);
  });

  test("preserves existing mutation error handling", async () => {
    const container = createHttpContainer();
    container.bind(ChannelBindingService).toConstantValue({
      list: async (): Promise<ChannelBindingSnapshot[]> => [],
      getById: async () => null,
      create: async () => {
        throw new Error("should not reach");
      },
      update: async () => null,
      delete: async () => false,
    } as unknown as ChannelBindingService);
    container.bind(AgentService).toConstantValue({
      list: async (): Promise<AgentConfigSnapshot[]> => [],
      getById: async () => null,
      register: async (): Promise<AgentConfigSnapshot> => ({
        id: "agent-1",
        name: "Echo",
        url: "http://localhost:3001",
        protocol: "a2a",
        createdAt: "2026-04-21T00:00:00.000Z",
      }),
      update: async () => null,
      delete: async () => {
        throw new ReferencedAgentError("agent-1", ["binding-1"]);
      },
    } as unknown as AgentService);
    container.bind(RuntimeStatusSourceToken).toConstantValue({
      listNodes: async () => [],
      listConnections: async () => [],
    });

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
      error: "Missing required fields: name, url",
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
