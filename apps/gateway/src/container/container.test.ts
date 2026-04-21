import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Container } from "inversify";

import { SERVICE_TOKENS, SYSTEM_TOKENS } from "@a2a-channels/di";

import { AgentService } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { buildGatewayConfig } from "../bootstrap/config.js";
import type { GatewayConfig } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";
import type { OutboxWorker } from "../infra/outbox-worker.js";
import { initStore } from "../services/initialization.js";

describe("buildGatewayContainer", () => {
  before(async () => {
    await initStore();
  });

  test("resolves typed config", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);
    const resolved = container.get<GatewayConfig>(SYSTEM_TOKENS.GatewayConfig);

    assert.equal(resolved.port, 7891);
  });

  test("keeps infra bindings singleton-scoped", () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);

    assert.strictEqual(
      container.get(SERVICE_TOKENS.AgentConfigStateRepository),
      container.get(SERVICE_TOKENS.AgentConfigStateRepository),
    );
    assert.strictEqual(
      container.get(SERVICE_TOKENS.ChannelBindingStateRepository),
      container.get(SERVICE_TOKENS.ChannelBindingStateRepository),
    );
    assert.strictEqual(
      container.get(SERVICE_TOKENS.DomainEventBus),
      container.get(SERVICE_TOKENS.DomainEventBus),
    );
    assert.strictEqual(
      container.get(SERVICE_TOKENS.OutboxWorker),
      container.get(SERVICE_TOKENS.OutboxWorker),
    );
  });

  test("resolves application services and basic reads", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);

    const channelBindingService =
      container.get<ChannelBindingService>(SERVICE_TOKENS.ChannelBindingService);
    const agentService = container.get<AgentService>(SERVICE_TOKENS.AgentService);

    assert.strictEqual(
      channelBindingService,
      container.get<ChannelBindingService>(SERVICE_TOKENS.ChannelBindingService),
    );
    assert.strictEqual(
      agentService,
      container.get<AgentService>(SERVICE_TOKENS.AgentService),
    );

    assert.ok(Array.isArray(await channelBindingService.list()));
    assert.ok(Array.isArray(await agentService.list()));

    const missingId = randomUUID();
    assert.equal(await channelBindingService.getById(missingId), null);
    assert.equal(await agentService.getById(missingId), null);
  });

  test("container builds once and can start the outbox worker", async () => {
    const container = buildGatewayContainer(buildGatewayConfig({ port: 7895 }));
    const worker = container.get<OutboxWorker>(SERVICE_TOKENS.OutboxWorker);

    worker.start();
    await worker.stop();

    assert.ok(worker);
  });
});
