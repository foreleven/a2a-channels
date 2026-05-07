import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Container } from "inversify";

import { AgentService } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import {
  buildGatewayConfig,
  GatewayConfigService,
} from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";

describe("buildGatewayContainer", () => {
  test("resolves typed config", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);
    const resolved = container.get(GatewayConfigService);

    assert.equal(resolved.port, 7891);
  });

  test("runtime config fields are exposed on the resolved config", async () => {
    const config = buildGatewayConfig({
      port: 7891,
      clusterMode: false,
      redisUrl: "redis://localhost:6379",
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7891",
    });
    const container: Container = buildGatewayContainer(config);
    const resolved = container.get(GatewayConfigService);

    assert.equal(resolved.clusterMode, false);
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

  test("resolves application services and basic reads", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);

    const channelBindingService = container.get(ChannelBindingService);
    const agentService = container.get(AgentService);

    assert.ok(Array.isArray(await channelBindingService.list()));
    assert.ok(Array.isArray(await agentService.list()));

    const missingId = randomUUID();
    assert.equal(await channelBindingService.getById(missingId), null);
    assert.equal(await agentService.getById(missingId), null);
  });
});
