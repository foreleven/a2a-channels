import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Container } from "inversify";
import type { AgentTransport } from "@a2a-channels/agent-transport";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { AgentService } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import {
  buildGatewayConfig,
  GatewayConfigService,
} from "../bootstrap/config.js";
import type { GatewayConfigSnapshot } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";
import { GatewayServer } from "../bootstrap/gateway-server.js";
import { GatewayApp } from "../http/app.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { AgentClientRegistry } from "../runtime/agent-client-registry.js";
import { RuntimeOwnershipState } from "../runtime/ownership-state.js";
import { ConnectionManager } from "../runtime/connection-manager.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { RuntimeAgentRegistry } from "../runtime/runtime-agent-registry.js";
import { RuntimeAssignmentService } from "../runtime/runtime-assignment-service.js";
import { RuntimeAssignmentCoordinator } from "../runtime/runtime-assignment-coordinator.js";
import { RuntimeCommandHandler } from "../runtime/runtime-command-handler.js";
import { DomainEventBridge } from "../runtime/domain-event-bridge.js";
import { RuntimeEventBus } from "../runtime/event-transport/index.js";
import { RuntimeScheduler } from "../runtime/scheduler.js";
import { LocalOwnershipGate } from "../runtime/local/local-ownership-gate.js";
import { LocalScheduler } from "../runtime/local/local-scheduler.js";
import { RuntimeOwnershipGate } from "../runtime/ownership-gate.js";
import { RuntimeOpenClawConfigProjection } from "../runtime/runtime-openclaw-config-projection.js";
import { AgentTransportToken } from "../runtime/transport-tokens.js";
import { LeaderScheduler } from "../runtime/cluster/leader-scheduler.js";
import { RedisOwnershipGate } from "../runtime/cluster/redis-ownership-gate.js";
import { RedisRuntimeEventBus } from "../runtime/cluster/redis-runtime-event-bus.js";

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
    assert.strictEqual(
      container.get(GatewayConfigService),
      container.get(GatewayConfigService),
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

  test("resolves relay runtime lifecycle", () => {
    const container = buildGatewayContainer(buildGatewayConfig({ port: 7896 }));

    assert.ok(container.get(RelayRuntime));
    assert.ok(container.get(GatewayServer));
    assert.ok(container.get(GatewayApp));
  });

  test("binds supported agent transports behind a multi-injection token", () => {
    const container = buildGatewayContainer(buildGatewayConfig({ port: 7896 }));
    const transports = container.getAll<AgentTransport>(AgentTransportToken);

    assert.deepEqual(transports.map((transport) => transport.protocol).sort(), [
      "a2a",
      "acp",
    ]);
  });

  test("binds LocalScheduler for single-instance runtime mode", () => {
    const container = buildGatewayContainer(
      buildGatewayConfig({ port: 7896, clusterMode: false }),
    );

    assert.ok(container.get(RuntimeScheduler) instanceof LocalScheduler);
    assert.ok(
      container.get(RuntimeOwnershipGate) instanceof LocalOwnershipGate,
    );
  });

  test("binds cluster runtime components when clusterMode is true", () => {
    const container = buildGatewayContainer(
      buildGatewayConfig({
        port: 7896,
        clusterMode: true,
        redisUrl: "redis://localhost:6379",
      }),
    );

    assert.ok(container.get(RuntimeScheduler) instanceof LeaderScheduler);
    assert.ok(
      container.get(RuntimeOwnershipGate) instanceof RedisOwnershipGate,
    );
    assert.ok(container.get(RuntimeEventBus) instanceof RedisRuntimeEventBus);
  });

  test("resolves runtime singleton collaborators through direct singleton bindings", () => {
    const container = buildGatewayContainer(buildGatewayConfig({ port: 7898 }));

    assert.strictEqual(
      container.get(LocalScheduler),
      container.get(LocalScheduler),
    );
    assert.strictEqual(
      container.get(RuntimeAgentRegistry),
      container.get(RuntimeAgentRegistry),
    );
    assert.strictEqual(
      container.get(RuntimeOpenClawConfigProjection),
      container.get(RuntimeOpenClawConfigProjection),
    );
    assert.strictEqual(
      container.get(ConnectionManager),
      container.get(ConnectionManager),
    );
    assert.strictEqual(
      container.get(RuntimeAssignmentService),
      container.get(RuntimeAssignmentService),
    );
    assert.strictEqual(
      container.get(AgentClientRegistry),
      container.get(AgentClientRegistry),
    );
    assert.strictEqual(
      container.get(RuntimeAssignmentCoordinator),
      container.get(RuntimeAssignmentCoordinator),
    );
    assert.strictEqual(
      container.get(RuntimeCommandHandler),
      container.get(RuntimeCommandHandler),
    );
    assert.strictEqual(
      container.get(DomainEventBridge),
      container.get(DomainEventBridge),
    );
    assert.strictEqual(
      container.get(RuntimeEventBus),
      container.get(RuntimeEventBus),
    );
    assert.strictEqual(
      container.get(RuntimeOwnershipState),
      container.get(RuntimeOwnershipState),
    );
  });

  test("resolves RelayRuntime as a singleton without manual options plumbing", () => {
    const container = buildGatewayContainer(buildGatewayConfig({ port: 7897 }));
    const first = container.get(RelayRuntime);
    const second = container.get(RelayRuntime);

    assert.strictEqual(first, second);
  });

  test("RelayRuntime no longer exposes static load()", () => {
    assert.equal(Object.hasOwn(RelayRuntime, "load"), false);
  });
});
