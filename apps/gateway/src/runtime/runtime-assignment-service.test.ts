import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { AgentTransport } from "@a2a-channels/agent-transport";
import type {
  AgentConfigSnapshot,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

import { AgentClientRegistry } from "./agent-client-registry.js";
import { AgentClientFactory } from "./agent-clients.js";
import { ConnectionManager } from "./connection-manager.js";
import { RuntimeOwnershipState } from "./ownership-state.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";
import { LocalOwnershipGate } from "./local/local-ownership-gate.js";
import type { OwnershipGate, OwnershipLease } from "./ownership-gate.js";

const agent: AgentConfigSnapshot = {
  id: "agent-1",
  name: "Agent One",
  url: "http://agent-1",
  protocol: "a2a",
  createdAt: new Date().toISOString(),
};

const binding: ChannelBindingSnapshot = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: { appId: "cli_1", appSecret: "sec_1" },
  agentId: agent.id,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const testTransport: AgentTransport = {
  protocol: "a2a",
  send: async () => ({ text: "ok" }),
};

function createService(): {
  connectionManager: ConnectionManager;
  service: RuntimeAssignmentService;
} {
  const ownershipState = new RuntimeOwnershipState();
  const agentRegistry = new RuntimeAgentRegistry(
    new AgentClientRegistry(new AgentClientFactory([testTransport])),
  );
  const openClawConfigProjection = new RuntimeOpenClawConfigProjection(
    ownershipState,
  );
  const connectionManager = new ConnectionManager(
    null as never,
    null as never,
    null as never,
  );
  const service = new RuntimeAssignmentService(
    agentRegistry,
    openClawConfigProjection,
    ownershipState,
    new LocalOwnershipGate(),
    connectionManager,
  );

  return { connectionManager, service };
}

function createServiceWithGate(ownershipGate: OwnershipGate): {
  connectionManager: ConnectionManager;
  service: RuntimeAssignmentService;
} {
  const ownershipState = new RuntimeOwnershipState();
  const agentRegistry = new RuntimeAgentRegistry(
    new AgentClientRegistry(new AgentClientFactory([testTransport])),
  );
  const openClawConfigProjection = new RuntimeOpenClawConfigProjection(
    ownershipState,
  );
  const connectionManager = new ConnectionManager(
    null as never,
    null as never,
    null as never,
  );
  const service = new RuntimeAssignmentService(
    agentRegistry,
    openClawConfigProjection,
    ownershipState,
    ownershipGate,
    connectionManager,
  );

  return { connectionManager, service };
}

describe("RuntimeAssignmentService", () => {
  test("releaseBinding stops the connection before removing local ownership state", async () => {
    const { connectionManager, service } = createService();
    let active = false;
    const observations: number[] = [];

    connectionManager.hasConnection = () => active;
    connectionManager.restartConnection = async () => {
      active = true;
    };
    connectionManager.stopConnection = async () => {
      observations.push(service.listConnectionStatuses().length);
      active = false;
    };

    await service.assignBinding(binding, agent);
    await service.releaseBinding(binding.id);

    assert.deepEqual(observations, [1]);
    assert.deepEqual(service.listConnectionStatuses(), []);
  });

  test("expired ownership lease cleans up local binding without releasing the stale lease", async () => {
    let releaseCalls = 0;
    const staleLease: OwnershipLease = {
      bindingId: binding.id,
      token: "stale-token",
    };
    const ownershipGate: OwnershipGate = {
      acquire: async () => staleLease,
      renew: async () => false,
      release: async () => {
        releaseCalls += 1;
      },
      isHeld: async () => false,
    };
    const { connectionManager, service } = createServiceWithGate(ownershipGate);
    let stopCalls = 0;

    connectionManager.hasConnection = () => false;
    connectionManager.restartConnection = async () => {};
    connectionManager.stopConnection = async () => {
      stopCalls += 1;
    };

    await service.assignBinding(binding, agent);
    await service.assignBinding(binding, agent);

    assert.equal(stopCalls, 1);
    assert.equal(releaseCalls, 0);
    assert.deepEqual(service.listConnectionStatuses(), []);
  });

  test("subscribes to connection status changes for owned bindings", async () => {
    const { connectionManager, service } = createService();

    connectionManager.hasConnection = () => false;
    connectionManager.restartConnection = async () => {};
    connectionManager.stopConnection = async () => {};

    await service.assignBinding(binding, agent);

    Reflect.get(connectionManager, "emitConnectionStatus").call(connectionManager, {
      binding,
      status: "connected",
      agentUrl: agent.url,
    });

    const [status] = service.listConnectionStatuses();
    assert.equal(status?.bindingId, binding.id);
    assert.equal(status?.status, "connected");
    assert.equal(status?.agentUrl, agent.url);
  });
});
