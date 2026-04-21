import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Container } from "inversify";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { AgentService } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { buildGatewayConfig } from "../bootstrap/config.js";
import type { GatewayConfig } from "../bootstrap/config.js";
import { GatewayConfigToken } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { initStore } from "../services/initialization.js";

describe("buildGatewayContainer", () => {
  before(async () => {
    await initStore();
  });

  test("resolves typed config", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);
    const resolved = container.get<GatewayConfig>(GatewayConfigToken);

    assert.equal(resolved.port, 7891);
  });

  test("runtime config fields are exposed on the resolved config", async () => {
    const config = buildGatewayConfig({
      port: 7891,
      clusterMode: true,
      redisUrl: "redis://localhost:6379",
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7891",
    });
    const container: Container = buildGatewayContainer(config);
    const resolved = container.get<GatewayConfig>(GatewayConfigToken);

    assert.equal(resolved.clusterMode, true);
    assert.equal(resolved.redisUrl, "redis://localhost:6379");
    assert.equal(resolved.nodeId, "node-a");
    assert.equal(resolved.nodeDisplayName, "Node A");
    assert.equal(resolved.runtimeAddress, "http://127.0.0.1:7891");
  });

  test("defaults nodeId deterministically when NODE_ID is unset", () => {
    const originalNodeId = process.env["NODE_ID"];
    const originalRuntimeAddress = process.env["RUNTIME_ADDRESS"];
    const originalNodeDisplayName = process.env["NODE_DISPLAY_NAME"];

    delete process.env["NODE_ID"];
    delete process.env["RUNTIME_ADDRESS"];
    delete process.env["NODE_DISPLAY_NAME"];

    try {
      const config = buildGatewayConfig({ port: 7892 });

      assert.equal(config.nodeId, "http://localhost:7892");
      assert.equal(config.nodeDisplayName, "Gateway Node");
    } finally {
      if (originalNodeId === undefined) {
        delete process.env["NODE_ID"];
      } else {
        process.env["NODE_ID"] = originalNodeId;
      }

      if (originalRuntimeAddress === undefined) {
        delete process.env["RUNTIME_ADDRESS"];
      } else {
        process.env["RUNTIME_ADDRESS"] = originalRuntimeAddress;
      }

      if (originalNodeDisplayName === undefined) {
        delete process.env["NODE_DISPLAY_NAME"];
      } else {
        process.env["NODE_DISPLAY_NAME"] = originalNodeDisplayName;
      }
    }
  });

  test("keeps infra bindings singleton-scoped", () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);

    assert.strictEqual(
      container.get(AgentConfigStateRepository),
      container.get(AgentConfigStateRepository),
    );
    assert.strictEqual(
      container.get(ChannelBindingStateRepository),
      container.get(ChannelBindingStateRepository),
    );
    assert.strictEqual(
      container.get(DomainEventBus),
      container.get(DomainEventBus),
    );
    assert.strictEqual(
      container.get(OutboxWorker),
      container.get(OutboxWorker),
    );
    assert.strictEqual(
      container.get<AgentConfigRepository>(AgentConfigRepository),
      container.get<AgentConfigRepository>(AgentConfigRepository),
    );
    assert.strictEqual(
      container.get<ChannelBindingRepository>(ChannelBindingRepository),
      container.get<ChannelBindingRepository>(ChannelBindingRepository),
    );
  });

  test("resolves application services and basic reads", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);

    const channelBindingService = container.get(ChannelBindingService);
    const agentService = container.get(AgentService);

    assert.strictEqual(
      channelBindingService,
      container.get(ChannelBindingService),
    );
    assert.strictEqual(agentService, container.get(AgentService));

    assert.ok(Array.isArray(await channelBindingService.list()));
    assert.ok(Array.isArray(await agentService.list()));

    const missingId = randomUUID();
    assert.equal(await channelBindingService.getById(missingId), null);
    assert.equal(await agentService.getById(missingId), null);
  });

  test("container builds once and can start the outbox worker", async () => {
    const container = buildGatewayContainer(buildGatewayConfig({ port: 7895 }));
    const worker = container.get(OutboxWorker);

    worker.start();
    await worker.stop();

    assert.ok(worker);
  });
});
