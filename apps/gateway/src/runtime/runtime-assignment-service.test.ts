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
  const connectionManager = new ConnectionManager();
  const service = new RuntimeAssignmentService(
    agentRegistry,
    openClawConfigProjection,
    ownershipState,
    new LocalOwnershipGate(),
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
});
