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
