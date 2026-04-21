import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Container } from "inversify";

import { SERVICE_TOKENS, SYSTEM_TOKENS } from "@a2a-channels/di";

import { buildGatewayConfig } from "../bootstrap/config.js";
import type { GatewayConfig } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";

describe("buildGatewayContainer", () => {
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
});
