import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Container } from "inversify";

import { SERVICE_TOKENS } from "@a2a-channels/di";

import { ReferencedAgentError } from "../application/agent-service.js";
import { buildHttpApp } from "./app.js";

describe("buildHttpApp", () => {
  test("registers channel, agent, and runtime routes against container services", async () => {
    const container = new Container({ defaultScope: "Singleton" });
    const channelService = {
      list: async () => [{ id: "binding-1", name: "Binding" }],
      getById: async (id: string) =>
        id === "binding-1" ? { id: "binding-1", name: "Binding" } : null,
      create: async () => ({ id: "binding-2" }),
      update: async () => ({ id: "binding-1" }),
      delete: async () => true,
    };
    const agentService = {
      list: async () => [{ id: "agent-1", name: "Echo" }],
      getById: async (id: string) =>
        id === "agent-1" ? { id: "agent-1", name: "Echo" } : null,
      register: async () => ({ id: "agent-2" }),
      update: async () => ({ id: "agent-1" }),
      delete: async () => true,
    };

    container
      .bind(SERVICE_TOKENS.ChannelBindingService)
      .toConstantValue(channelService);
    container.bind(SERVICE_TOKENS.AgentService).toConstantValue(agentService);

    const app = buildHttpApp(container, {
      corsOrigin: "http://localhost:3000",
      runtime: {
        listConnectionStatuses: () => [
          {
            bindingId: "binding-1",
            status: "connected",
            agentUrl: "http://localhost:3001",
            updatedAt: "2026-04-21T00:00:00.000Z",
          },
        ],
      },
      webDir: "/tmp/does-not-exist",
    });

    const channelsResponse = await app.request("/api/channels");
    assert.equal(channelsResponse.status, 200);
    assert.deepEqual(await channelsResponse.json(), [{ id: "binding-1", name: "Binding" }]);

    const agentsResponse = await app.request("/api/agents");
    assert.equal(agentsResponse.status, 200);
    assert.deepEqual(await agentsResponse.json(), [{ id: "agent-1", name: "Echo" }]);

    const runtimeResponse = await app.request("/api/runtime/connections");
    assert.equal(runtimeResponse.status, 200);
    assert.deepEqual(await runtimeResponse.json(), [
      {
        bindingId: "binding-1",
        status: "connected",
        agentUrl: "http://localhost:3001",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);
  });

  test("preserves existing mutation error handling", async () => {
    const container = new Container({ defaultScope: "Singleton" });
    container.bind(SERVICE_TOKENS.ChannelBindingService).toConstantValue({
      list: async () => [],
      getById: async () => null,
      create: async () => {
        throw new Error("should not reach");
      },
      update: async () => null,
      delete: async () => false,
    });
    container.bind(SERVICE_TOKENS.AgentService).toConstantValue({
      list: async () => [],
      getById: async () => null,
      register: async () => ({ id: "agent-1" }),
      update: async () => null,
      delete: async () => {
        throw new ReferencedAgentError("agent-1", ["binding-1"]);
      },
    });

    const app = buildHttpApp(container, {
      corsOrigin: "*",
      runtime: {
        listConnectionStatuses: () => [],
      },
      webDir: "/tmp/does-not-exist",
    });

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
