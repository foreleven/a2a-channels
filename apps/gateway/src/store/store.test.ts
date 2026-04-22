/**
 * Integration tests for the gateway store.
 *
 * Each test group resets the database via `resetDB()` so tests remain
 * independent.  The test runner must set DB_PATH before this module
 * loads (done via the `test` npm script in package.json).
 */

import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { AgentTransport } from "@a2a-channels/core";
import { prisma } from "./prisma.js";
import { AgentService, ReferencedAgentError } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { DuplicateEnabledBindingError } from "../application/errors.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { buildGatewayConfig } from "../bootstrap/config.js";
import { buildRuntimeBootstrap } from "../runtime/bootstrap.js";
import { AgentClientRegistry } from "../runtime/agent-client-registry.js";
import { ConnectionManagerProvider } from "../runtime/connection-manager-provider.js";
import { LocalNodeRuntimeStateStore } from "../runtime/local-node-runtime-state-store.js";
import type { NodeRuntimeStateStore } from "../runtime/node-runtime-state-store.js";
import { PluginHostProvider } from "../runtime/plugin-host-provider.js";
import { buildRedisCoordinationKeys } from "../runtime/cluster/redis-coordination.js";
import { createLocalOwnershipGate } from "../runtime/local-ownership-gate.js";
import { LocalScheduler } from "../runtime/local-scheduler.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { RelayRuntimeAssemblyProvider } from "../runtime/relay-runtime-assembly-provider.js";
import { RuntimeAssignmentCoordinator } from "../runtime/runtime-assignment-coordinator.js";
import {
  RuntimeNodeState,
  type LocalRuntimeSnapshot,
} from "../runtime/runtime-node-state.js";
import type { RuntimeBootstrapper } from "../runtime/runtime-bootstrapper.js";
import { TransportRegistryProvider } from "../runtime/transport-registry-provider.js";
import { initStore, seedDefaults } from "../services/initialization.js";
import { buildOpenClawConfig } from "../services/openclaw-config.js";
import {
  getAgentUrlForBinding,
  getAgentUrlForChannelAccount,
  getAgentProtocolForUrl,
} from "../services/routing.js";
import { createRuntimeOwnershipState } from "../runtime/ownership-state.js";
import { createReconnectPolicy, type ReconnectPolicy } from "../runtime/reconnect-policy.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const GATEWAY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Push the Prisma schema to the test DB (creates tables if absent). */
function pushSchema(): void {
  execSync(
    "node_modules/.bin/prisma db push --schema=prisma/schema.prisma",
    { cwd: GATEWAY_ROOT, stdio: "pipe" },
  );
}

/** Delete all rows from the gateway state, outbox, and legacy event tables. */
async function resetDB(): Promise<void> {
  await prisma.outboxEvent.deleteMany();
  await prisma.channelBinding.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.runtimeNode.deleteMany();
  await initStore();
}

const FEISHU_BINDING_DATA = {
  name: "Test Feishu Bot",
  channelType: "feishu",
  accountId: "test-account",
  channelConfig: { appId: "cli_abc", appSecret: "secret123" },
  agentId: "test-agent-id",
  enabled: true,
} as const;

const AGENT_DATA = {
  name: "Test Agent",
  url: "http://localhost:3001",
  protocol: "a2a",
  description: "A test agent",
} as const;

async function createTestAgent(url: string = AGENT_DATA.url) {
  return createAgentConfig({
    ...AGENT_DATA,
    url,
    name: `Agent ${url}`,
  });
}

function makeInfra() {
  const bindingRepo = new ChannelBindingStateRepository();
  const agentRepo = new AgentConfigStateRepository();
  return {
    bindingService: new ChannelBindingService(bindingRepo, agentRepo),
    agentService: new AgentService(agentRepo, bindingRepo),
    bindingRepo,
    agentRepo,
  };
}

interface RelayRuntimeTestOptions {
  config?: Parameters<typeof buildGatewayConfig>[0];
  stateStore?: NodeRuntimeStateStore;
  runtimeNodeState?: RuntimeNodeState;
  pluginHostProvider?: PluginHostProvider;
  agentClientRegistry?: AgentClientRegistry;
  connectionManagerProvider?: ConnectionManagerProvider;
  assemblyProvider?: RelayRuntimeAssemblyProvider;
  ownershipState?: ReturnType<typeof createRuntimeOwnershipState>;
  reconnectPolicy?: ReconnectPolicy;
  transports?: AgentTransport[];
}

function createRelayRuntime(options: RelayRuntimeTestOptions = {}) {
  const config = buildGatewayConfig(
    options.config ?? {
      clusterMode: false,
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7890",
    },
  );
  const stateStore =
    options.stateStore ?? ({ publishNodeSnapshot: async () => {} } as NodeRuntimeStateStore);
  const runtimeNodeState = options.runtimeNodeState ?? new RuntimeNodeState(config);
  const pluginHostProvider = options.pluginHostProvider ?? new PluginHostProvider();
  const connectionManagerProvider =
    options.connectionManagerProvider ?? new ConnectionManagerProvider();
  const assemblyProvider =
    options.assemblyProvider ??
    new RelayRuntimeAssemblyProvider(pluginHostProvider, connectionManagerProvider);
  const transportRegistryProvider = new TransportRegistryProvider(
    options.transports ?? [
      {
        protocol: "a2a",
        send: async () => ({ text: "" }),
      },
    ],
  );
  const agentClientRegistry =
    options.agentClientRegistry ?? new AgentClientRegistry(transportRegistryProvider);
  const ownershipState =
    options.ownershipState ??
    createRuntimeOwnershipState({ reconnectPolicy: options.reconnectPolicy });

  return new RelayRuntime(
    runtimeNodeState,
    stateStore,
    agentClientRegistry,
    assemblyProvider,
    ownershipState,
  );
}

async function listChannelBindings() {
  return makeInfra().bindingService.list();
}

async function getChannelBinding(id: string) {
  return makeInfra().bindingService.getById(id);
}

async function ensureTestAgent(
  agentId: string,
  url: string = `http://test-agent-${agentId}:3001`,
) {
  const existing = await prisma.agent.findUnique({ where: { id: agentId } });
  if (existing) {
    return;
  }

  await prisma.agent.create({
    data: {
      id: agentId,
      name: `Agent ${agentId}`,
      url,
      protocol: "a2a",
    },
  });
}

async function createChannelBinding(
  data: Parameters<ChannelBindingService["create"]>[0],
) {
  await ensureTestAgent(data.agentId);
  return makeInfra().bindingService.create(data);
}

async function updateChannelBinding(
  id: string,
  data: Parameters<ChannelBindingService["update"]>[1],
) {
  if (typeof data.agentId === "string") {
    await ensureTestAgent(data.agentId);
  }
  return makeInfra().bindingService.update(id, data);
}

async function deleteChannelBinding(id: string) {
  return makeInfra().bindingService.delete(id);
}

async function listAgentConfigs() {
  return makeInfra().agentService.list();
}

async function getAgentConfig(id: string) {
  return makeInfra().agentService.getById(id);
}

async function createAgentConfig(data: Parameters<AgentService["register"]>[0]) {
  return makeInfra().agentService.register(data);
}

async function updateAgentConfig(
  id: string,
  data: Parameters<AgentService["update"]>[1],
) {
  return makeInfra().agentService.update(id, data);
}

async function deleteAgentConfig(id: string) {
  return makeInfra().agentService.delete(id);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(() => {
  pushSchema();
});

// ---------------------------------------------------------------------------
// ChannelBinding CRUD
// ---------------------------------------------------------------------------

describe("ChannelBinding CRUD", () => {
  beforeEach(resetDB);

  test("create stores all fields and returns a mapped binding", async () => {
    const binding = await createChannelBinding(FEISHU_BINDING_DATA);

    assert.ok(binding.id, "id should be non-empty");
    assert.equal(binding.name, FEISHU_BINDING_DATA.name);
    assert.equal(binding.channelType, FEISHU_BINDING_DATA.channelType);
    assert.equal(binding.accountId, FEISHU_BINDING_DATA.accountId);
    assert.deepEqual(binding.channelConfig, FEISHU_BINDING_DATA.channelConfig);
    assert.equal(binding.agentId, FEISHU_BINDING_DATA.agentId);
    assert.equal(binding.enabled, true);
    assert.ok(binding.createdAt, "createdAt should be set");
  });

  test("list returns empty array when no bindings exist", async () => {
    const list = await listChannelBindings();
    assert.deepEqual(list, []);
  });

  test("list returns all bindings ordered by createdAt asc", async () => {
    const b1 = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "First",
    });
    const b2 = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "account-2",
      name: "Second",
    });

    const list = await listChannelBindings();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, b1.id);
    assert.equal(list[1]?.id, b2.id);
  });

  test("get returns null for an unknown id", async () => {
    const result = await getChannelBinding("nonexistent-id");
    assert.equal(result, null);
  });

  test("get returns the binding for a known id", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    const fetched = await getChannelBinding(created.id);

    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, created.name);
  });

  test("update returns null for an unknown id", async () => {
    const result = await updateChannelBinding("nonexistent-id", {
      name: "New Name",
    });
    assert.equal(result, null);
  });

  test("update patches only the provided fields", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    const updated = await updateChannelBinding(created.id, {
      name: "Updated Name",
      enabled: false,
    });

    assert.ok(updated);
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Updated Name");
    assert.equal(updated.enabled, false);
    // Unchanged fields should remain
    assert.equal(updated.channelType, FEISHU_BINDING_DATA.channelType);
    assert.equal(updated.agentId, FEISHU_BINDING_DATA.agentId);
  });

  test("update persists changes to the database", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    await updateChannelBinding(created.id, { name: "DB Persisted" });
    const fetched = await getChannelBinding(created.id);

    assert.ok(fetched);
    assert.equal(fetched.name, "DB Persisted");
  });

  test("delete returns false for an unknown id", async () => {
    const result = await deleteChannelBinding("nonexistent-id");
    assert.equal(result, false);
  });

  test("delete removes the binding and returns true", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    const deleted = await deleteChannelBinding(created.id);

    assert.equal(deleted, true);
    const fetched = await getChannelBinding(created.id);
    assert.equal(fetched, null);
  });

  test("create immediately reflects in DB-backed routing", async () => {
    const agent = await createTestAgent("http://routing-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "routing-test",
      agentId: agent.id,
    });

    const url = await getAgentUrlForBinding(binding.id, "http://default");
    assert.equal(url, agent.url);
  });

  test("update immediately reflects in DB-backed routing", async () => {
    const oldAgent = await createTestAgent("http://old-agent:4000");
    const newAgent = await createTestAgent("http://new-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "routing-update",
      agentId: oldAgent.id,
    });
    await updateChannelBinding(binding.id, {
      agentId: newAgent.id,
    });

    const url = await getAgentUrlForBinding(binding.id, "http://default");
    assert.equal(url, newAgent.url);
  });

  test("delete immediately reflects in DB-backed routing", async () => {
    const agent = await createTestAgent("http://to-delete:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "routing-delete",
      agentId: agent.id,
    });
    await deleteChannelBinding(binding.id);

    const url = await getAgentUrlForBinding(binding.id, "http://fallback");
    assert.equal(url, "http://fallback");
  });
  test("rejects creating a second enabled binding for the same channel/account", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);

    await assert.rejects(
      createChannelBinding({
        ...FEISHU_BINDING_DATA,
        name: "Duplicate",
        agentId: "http://duplicate-agent:4000",
      }),
      DuplicateEnabledBindingError,
    );
  });

  test("allows a disabled duplicate binding for the same channel/account", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);

    const duplicate = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Disabled Duplicate",
      enabled: false,
    });

    assert.equal(duplicate.enabled, false);
  });

  test("rejects enabling a disabled duplicate binding", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);
    const duplicate = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Disabled Duplicate",
      enabled: false,
    });

    await assert.rejects(
      updateChannelBinding(duplicate.id, { enabled: true }),
      DuplicateEnabledBindingError,
    );
  });

  test("rejects updating a binding into another enabled channel/account pair", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);
    const other = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "other-account",
    });

    await assert.rejects(
      updateChannelBinding(other.id, { accountId: FEISHU_BINDING_DATA.accountId }),
      DuplicateEnabledBindingError,
    );
  });

  test("allows the same accountId to be enabled for different channel types", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);
    const slack = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Slack Bot",
      channelType: "slack",
      channelConfig: { token: "xoxb" },
    });

    assert.equal(slack.channelType, "slack");
  });

  test("rejects creating a binding when the referenced agent id does not exist", async () => {
    const { bindingService } = makeInfra();
    await assert.rejects(
      bindingService.create({
        ...FEISHU_BINDING_DATA,
        accountId: "missing-agent-create",
        agentId: "missing-agent-id",
      }),
      /Agent missing-agent-id not found/,
    );
  });

  test("rejects updating a binding to reference a missing agent id", async () => {
    const { bindingService } = makeInfra();
    const agent = await createTestAgent("http://existing-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "missing-agent-update",
      agentId: agent.id,
    });

    await assert.rejects(
      bindingService.update(binding.id, { agentId: "missing-agent-id" }),
      /Agent missing-agent-id not found/,
    );
  });
});

describe("RuntimeOwnershipState", () => {
  test("attachBinding seeds an idle runtime status", async () => {
    const state = createRuntimeOwnershipState();
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    const statuses = state.listConnectionStatuses();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.bindingId, "binding-1");
    assert.equal(statuses[0]?.status, "idle");

    if (statuses[0]) {
      statuses[0].status = "error";
    }

    assert.equal(state.listConnectionStatuses()[0]?.status, "idle");
  });

  test("detachBinding removes the record", async () => {
    const state = createRuntimeOwnershipState();
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    state.detachBinding("binding-1");

    assert.deepEqual(state.listConnectionStatuses(), []);
  });

  test("markConnecting produces an observable connecting status", async () => {
    const state = createRuntimeOwnershipState();
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    state.markConnecting("binding-1", "http://agent-1");

    assert.equal(state.listConnectionStatuses()[0]?.status, "connecting");
  });

  test("markDisconnected returns a reconnect decision and updates status", async () => {
    const state = createRuntimeOwnershipState({
      reconnectPolicy: createReconnectPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 8000,
      }),
    });
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    const retry = state.markDisconnected("binding-1", "http://agent-1");
    const statuses = state.listConnectionStatuses();

    assert.equal(retry.attempt, 1);
    assert.equal(retry.delayMs, 1000);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.bindingId, "binding-1");
    assert.equal(statuses[0]?.status, "disconnected");
  });

  test("markError updates observable error status and surfaces the error string", async () => {
    const state = createRuntimeOwnershipState();
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    state.markError("binding-1", new Error("socket closed"));

    const statuses = state.listConnectionStatuses();
    assert.equal(statuses[0]?.status, "error");
    assert.equal(statuses[0]?.error, "Error: socket closed");
  });

  test("transition results are defensive copies", async () => {
    const state = createRuntimeOwnershipState();
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    const status = state.markConnected("binding-1", "http://agent-1");
    status.status = "error";

    assert.equal(state.listConnectionStatuses()[0]?.status, "connected");
  });

  test("connected state resets reconnect attempt state", async () => {
    const state = createRuntimeOwnershipState({
      reconnectPolicy: createReconnectPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 8000,
      }),
    });
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    const firstRetry = state.markError("binding-1", new Error("socket closed"));
    state.markConnected("binding-1", "http://agent-1");
    const secondRetry = state.markError("binding-1", new Error("socket closed"));

    assert.equal(firstRetry.attempt, 1);
    assert.equal(secondRetry.attempt, 1);
    assert.equal(secondRetry.delayMs, 1000);
  });

  test("reconnect policy caps exponential growth at the max delay", async () => {
    const policy = createReconnectPolicy({
      baseDelayMs: 1000,
      maxDelayMs: 8000,
    });

    assert.equal(policy.next(1).delayMs, 1000);
    assert.equal(policy.next(2).delayMs, 2000);
    assert.equal(policy.next(3).delayMs, 4000);
    assert.equal(policy.next(4).delayMs, 8000);
    assert.equal(policy.next(5).delayMs, 8000);
  });
});

describe("OwnershipGate", () => {
  test("local ownership gate grants and releases binding ownership", async () => {
    const gate = createLocalOwnershipGate();

    const lease = await gate.acquire("binding-1");
    assert.ok(lease);
    assert.equal(lease.bindingId, "binding-1");
    assert.equal(await gate.isHeld("binding-1"), true);

    await gate.release(lease);
    assert.equal(await gate.isHeld("binding-1"), false);
  });
});

describe("Redis coordination contracts", () => {
  test("binding lease keys include the binding id and owner instance id", async () => {
    const keys = buildRedisCoordinationKeys({
      instanceId: "gateway-a",
      bindingId: "binding-1",
    });

    assert.equal(keys.bindingLeaseKey, "a2a:binding:binding-1:lease");
    assert.equal(keys.instanceHeartbeatKey, "a2a:instance:gateway-a:heartbeat");
    assert.equal(keys.leaderLeaseKey, "a2a:cluster:leader");
  });
});

describe("RuntimeNodeStateRepository", () => {
  beforeEach(resetDB);

  test("upserts runtime node records and returns the latest row", async () => {
    const { RuntimeNodeStateRepository } = await import(
      "../infra/runtime-node-repo.js"
    );
    const repo = new RuntimeNodeStateRepository();

    await repo.upsert({
      nodeId: "node-1",
      displayName: "Runtime Node 1",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      registeredAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await repo.upsert({
      nodeId: "node-1",
      displayName: "Runtime Node 1 Updated",
      mode: "cluster",
      lastKnownAddress: "http://127.0.0.1:7891",
      registeredAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const rows = await repo.list();

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      nodeId: "node-1",
      displayName: "Runtime Node 1 Updated",
      mode: "cluster",
      lastKnownAddress: "http://127.0.0.1:7891",
      registeredAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
  });
});

describe("RuntimeClusterStateReader", () => {
  beforeEach(resetDB);

  test("merges DB bindings with local runtime state", async () => {
    const { RuntimeClusterStateReader } = await import(
      "../runtime/runtime-cluster-state-reader.js"
    );
    const stateStore = new LocalNodeRuntimeStateStore();
    const bindingRepo = new ChannelBindingStateRepository();
    const agentRepo = new AgentConfigStateRepository();
    const runtimeNodeRepo = new (await import("../infra/runtime-node-repo.js"))
      .RuntimeNodeStateRepository();

    const agent = await createAgentConfig({
      name: "Echo",
      url: "http://localhost:3001",
      protocol: "a2a",
    });
    const binding = await createChannelBinding({
      name: "Binding",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: agent.id,
      enabled: true,
    });

    await runtimeNodeRepo.upsert({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      registeredAt: new Date("2026-04-21T08:00:00.000Z"),
      updatedAt: new Date("2026-04-21T08:00:00.000Z"),
    });
    await stateStore.publishNodeSnapshot({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      lifecycle: "ready",
      bindingStatuses: [
        {
          bindingId: binding.id,
          status: "connected",
          agentUrl: "http://localhost:3001",
          updatedAt: "2026-04-21T08:00:00.000Z",
        },
      ],
      updatedAt: "2026-04-21T08:00:00.000Z",
    });

    const reader = new RuntimeClusterStateReader(
      bindingRepo,
      agentRepo,
      runtimeNodeRepo,
      stateStore,
    );

    const nodes = await reader.listNodes();
    const connections = await reader.listConnections();

    assert.deepEqual(nodes, [
      {
        nodeId: "node-a",
        displayName: "Gateway Node A",
        mode: "local",
        lastKnownAddress: "http://127.0.0.1:7890",
        lifecycle: "ready",
        bindingCount: 1,
        updatedAt: "2026-04-21T08:00:00.000Z",
      },
    ]);
    assert.deepEqual(connections, [
      {
        bindingId: binding.id,
        bindingName: "Binding",
        channelType: "feishu",
        accountId: "default",
        agentId: agent.id,
        agentUrl: "http://localhost:3001",
        ownerNodeId: "node-a",
        status: "connected",
        updatedAt: "2026-04-21T08:00:00.000Z",
      },
    ]);
  });

  test("prefers the newest snapshot when multiple snapshots exist for a node", async () => {
    const { RuntimeClusterStateReader } = await import(
      "../runtime/runtime-cluster-state-reader.js"
    );
    const stateStore = new LocalNodeRuntimeStateStore();
    const bindingRepo = new ChannelBindingStateRepository();
    const agentRepo = new AgentConfigStateRepository();
    const runtimeNodeRepo = new (await import("../infra/runtime-node-repo.js"))
      .RuntimeNodeStateRepository();

    await runtimeNodeRepo.upsert({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      registeredAt: new Date("2026-04-21T08:00:00.000Z"),
      updatedAt: new Date("2026-04-21T08:00:00.000Z"),
    });
    await stateStore.publishNodeSnapshot({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      lifecycle: "bootstrapping",
      bindingStatuses: [],
      updatedAt: "2026-04-21T08:00:00.000Z",
    });
    await stateStore.publishNodeSnapshot({
      nodeId: "node-a",
      displayName: "Gateway Node A Updated",
      mode: "cluster",
      lastKnownAddress: "http://127.0.0.1:7891",
      lifecycle: "ready",
      bindingStatuses: [],
      updatedAt: "2026-04-21T09:00:00.000Z",
    });

    const reader = new RuntimeClusterStateReader(
      bindingRepo,
      agentRepo,
      runtimeNodeRepo,
      stateStore,
    );

    assert.deepEqual(await reader.listNodes(), [
      {
        nodeId: "node-a",
        displayName: "Gateway Node A Updated",
        mode: "cluster",
        lastKnownAddress: "http://127.0.0.1:7891",
        lifecycle: "ready",
        bindingCount: 0,
        updatedAt: "2026-04-21T09:00:00.000Z",
      },
    ]);
  });

  test("clears ownership when the newest snapshot omits a previously owned binding", async () => {
    const { RuntimeClusterStateReader } = await import(
      "../runtime/runtime-cluster-state-reader.js"
    );
    const stateStore = new LocalNodeRuntimeStateStore();
    const bindingRepo = new ChannelBindingStateRepository();
    const agentRepo = new AgentConfigStateRepository();
    const runtimeNodeRepo = new (await import("../infra/runtime-node-repo.js"))
      .RuntimeNodeStateRepository();

    const agent = await createAgentConfig({
      name: "Echo",
      url: "http://localhost:3001",
      protocol: "a2a",
    });
    const binding = await createChannelBinding({
      name: "Binding",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: agent.id,
      enabled: true,
    });

    await runtimeNodeRepo.upsert({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      registeredAt: new Date("2026-04-21T08:00:00.000Z"),
      updatedAt: new Date("2026-04-21T08:00:00.000Z"),
    });
    await stateStore.publishNodeSnapshot({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      lifecycle: "ready",
      bindingStatuses: [
        {
          bindingId: binding.id,
          status: "connected",
          agentUrl: "http://localhost:3001",
          updatedAt: "2026-04-21T08:00:00.000Z",
        },
      ],
      updatedAt: "2026-04-21T08:00:00.000Z",
    });
    await stateStore.publishNodeSnapshot({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "local",
      lastKnownAddress: "http://127.0.0.1:7890",
      lifecycle: "ready",
      bindingStatuses: [],
      updatedAt: "2026-04-21T09:00:00.000Z",
    });

    const reader = new RuntimeClusterStateReader(
      bindingRepo,
      agentRepo,
      runtimeNodeRepo,
      stateStore,
    );

    assert.deepEqual(await reader.listConnections(), [
      {
        bindingId: binding.id,
        bindingName: "Binding",
        channelType: "feishu",
        accountId: "default",
        agentId: agent.id,
        agentUrl: "http://localhost:3001",
        ownerNodeId: null,
        status: "idle",
        updatedAt: null,
      },
    ]);
  });
});

describe("cluster bootstrap wiring", () => {
  test("cluster mode uses the leader scheduler instead of LocalScheduler", async () => {
    const coordinator = {
      reconcile: async () => {},
    } as unknown as RuntimeAssignmentCoordinator;
    const result = buildRuntimeBootstrap({
      clusterMode: true,
      redisUrl: "redis://localhost:6379",
      coordinator,
      relay: {} as RelayRuntime,
      eventBus: new DomainEventBus(),
    });

    assert.equal(result.schedulerKind, "leader");
  });

  test("leader scheduler triggers initial and event-driven reconciles", async () => {
    const { LeaderScheduler } = await import(
      "../runtime/cluster/leader-scheduler.js"
    );
    const bus = new DomainEventBus();
    let reconcileCalls = 0;
    const scheduler = new LeaderScheduler({
      coordinator: {
        reconcile: async () => {
          reconcileCalls += 1;
        },
      } as unknown as RuntimeAssignmentCoordinator,
      eventBus: bus,
      ownershipGate: createLocalOwnershipGate(),
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(reconcileCalls >= 1);
    reconcileCalls = 0;

    bus.publish({
      eventType: "AgentDeleted.v1",
      agentId: "agent-1",
      occurredAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await scheduler.stop();

    assert.ok(reconcileCalls >= 1);
  });

  test("leader scheduler waits for in-flight reconcile before releasing leadership", async () => {
    const { LeaderScheduler } = await import(
      "../runtime/cluster/leader-scheduler.js"
    );
    const bus = new DomainEventBus();
    const events: string[] = [];
    let resolveReconcile: (() => void) | undefined;
    const scheduler = new LeaderScheduler({
      coordinator: {
        reconcile: async () => {
          events.push("reconcile-start");
          await new Promise<void>((resolve) => {
            resolveReconcile = resolve;
          });
          events.push("reconcile-end");
        },
      } as unknown as RuntimeAssignmentCoordinator,
      eventBus: bus,
      ownershipGate: {
        acquire: async () => ({
          bindingId: "runtime-assignment-coordinator",
          token: "lease-1",
        }),
        renew: async () => true,
        release: async () => {
          events.push("release");
        },
        isHeld: async () => false,
      },
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopPromise = scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ["reconcile-start"]);

    resolveReconcile?.();
    await stopPromise;

    assert.deepEqual(events, ["reconcile-start", "reconcile-end", "release"]);
  });

  test("leader scheduler skips reconcile when ownership is unavailable", async () => {
    const { LeaderScheduler } = await import(
      "../runtime/cluster/leader-scheduler.js"
    );
    const bus = new DomainEventBus();
    let reconcileCalls = 0;
    const scheduler = new LeaderScheduler({
      coordinator: {
        reconcile: async () => {
          reconcileCalls += 1;
        },
      } as unknown as RuntimeAssignmentCoordinator,
      eventBus: bus,
      ownershipGate: {
        acquire: async () => null,
        renew: async () => false,
        release: async () => {},
        isHeld: async () => false,
      },
    });

    scheduler.start();
    bus.publish({
      eventType: "AgentDeleted.v1",
      agentId: "agent-1",
      occurredAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await scheduler.stop();

    assert.equal(reconcileCalls, 0);
  });

  test("single-instance mode keeps LocalScheduler", async () => {
    const coordinator = {
      reconcile: async () => {},
    } as unknown as RuntimeAssignmentCoordinator;
    const result = buildRuntimeBootstrap({
      clusterMode: false,
      coordinator,
      relay: {} as RelayRuntime,
      eventBus: new DomainEventBus(),
    });

    assert.equal(result.schedulerKind, "local");
    assert.equal(result.scheduler instanceof LocalScheduler, true);
  });
});

describe("gateway startup sequencing", () => {
  test("startGateway starts HTTP before runtime bootstrap resolves", async () => {
    const { startGateway } = await import("../bootstrap/start-gateway.js");
    const events: string[] = [];
    let resolveBootstrap!: () => void;
    let bootstrapResolved = false;

    const bootstrapGate = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });

    const gateway = startGateway({
      app: {
        fetch: () => new Response("ok"),
      },
      port: 7897,
      outboxWorker: {
        start: () => {
          events.push("outbox:start");
        },
        stop: async () => {
          events.push("outbox:stop");
        },
      } as OutboxWorker,
      runtimeBootstrapper: {
        bootstrap: async () => {
          events.push("bootstrap:start");
          await bootstrapGate;
          bootstrapResolved = true;
          events.push("bootstrap:done");
        },
        shutdown: async () => {
          events.push("bootstrap:shutdown");
        },
      } as unknown as RuntimeBootstrapper,
      logger: {
        info: (message: string) => {
          events.push(`info:${message}`);
        },
        error: () => {
          events.push("log:error");
        },
      },
      serve: (_options, onListening) => {
        events.push("http:serve");
        onListening?.({ port: 7897 } as never);
        return {
          close: () => {
            events.push("http:close");
          },
        } as never;
      },
    });

    await waitFor(() => events.includes("bootstrap:start"));

    assert.ok(events.includes("outbox:start"));
    assert.ok(events.includes("http:serve"));
    assert.ok(events.indexOf("outbox:start") < events.indexOf("http:serve"));
    assert.equal(bootstrapResolved, false);

    resolveBootstrap();
    await waitFor(() => bootstrapResolved);
    await gateway.shutdown();

    assert.ok(events.includes("bootstrap:done"));
    assert.ok(events.includes("bootstrap:shutdown"));
    assert.ok(events.includes("outbox:stop"));
    assert.ok(events.includes("http:close"));
  });

  test("startGateway exposes bootstrap rejection", async () => {
    const { startGateway } = await import("../bootstrap/start-gateway.js");
    const events: string[] = [];

    const gateway = startGateway({
      app: {
        fetch: () => new Response("ok"),
      },
      port: 7898,
      outboxWorker: {
        start: () => {
          events.push("outbox:start");
        },
        stop: async () => {
          events.push("outbox:stop");
        },
      } as OutboxWorker,
      runtimeBootstrapper: {
        bootstrap: async () => {
          events.push("bootstrap:start");
          throw new Error("bootstrap rejection");
        },
        shutdown: async () => {
          events.push("bootstrap:shutdown");
        },
      } as unknown as RuntimeBootstrapper,
      logger: {
        info: (message: string) => {
          events.push(`info:${message}`);
        },
        error: (message: string, error?: unknown) => {
          events.push(`error:${message}:${String(error)}`);
        },
      },
      serve: (_options, onListening) => {
        events.push("http:serve");
        onListening?.({ port: 7898 } as never);
        return {
          close: () => {
            events.push("http:close");
          },
        } as never;
      },
    });

    await assert.rejects(gateway.runtimeBootstrap, /bootstrap rejection/);
    await gateway.shutdown();

    assert.ok(
      events.some((event) =>
        event.includes("error:[gateway] runtime bootstrap failed:Error: bootstrap rejection"),
      ),
    );
    assert.ok(events.includes("bootstrap:shutdown"));
    assert.ok(events.includes("outbox:stop"));
    assert.ok(events.includes("http:close"));
  });

  test("startGateway retries bootstrap after initial rejection", async () => {
    const { startGateway } = await import("../bootstrap/start-gateway.js");
    const events: string[] = [];
    let attempts = 0;

    const gateway = startGateway({
      app: {
        fetch: () => new Response("ok"),
      },
      port: 7901,
      outboxWorker: {
        start: () => {
          events.push("outbox:start");
        },
        stop: async () => {
          events.push("outbox:stop");
        },
      } as OutboxWorker,
      runtimeBootstrapper: {
        bootstrap: async () => {
          attempts += 1;
          events.push(`bootstrap:start:${attempts}`);
          if (attempts === 1) {
            throw new Error("bootstrap rejection");
          }
          events.push("bootstrap:done");
        },
        shutdown: async () => {
          events.push("bootstrap:shutdown");
        },
      } as unknown as RuntimeBootstrapper,
      logger: {
        info: () => {},
        error: (message: string, error?: unknown) => {
          events.push(`error:${message}:${String(error)}`);
        },
      },
      serve: (_options, onListening) => {
        events.push("http:serve");
        onListening?.({ port: 7901 } as never);
        return {
          close: () => {
            events.push("http:close");
          },
        } as never;
      },
      runtimeBootstrapRetryDelayMs: 5,
    });

    await assert.rejects(gateway.runtimeBootstrap, /bootstrap rejection/);
    await waitFor(() => attempts === 2);
    await waitFor(() => events.includes("bootstrap:done"));
    await gateway.shutdown();

    assert.deepEqual(
      events.filter((event) => event.startsWith("bootstrap:start:")),
      ["bootstrap:start:1", "bootstrap:start:2"],
    );
    assert.ok(
      events.some((event) =>
        event.includes("error:[gateway] runtime bootstrap failed:Error: bootstrap rejection"),
      ),
    );
  });

  test("startGateway shutdown while bootstrap is in flight waits for cleanup", async () => {
    const { startGateway } = await import("../bootstrap/start-gateway.js");
    const events: string[] = [];
    let resolveBootstrap!: () => void;
    let shutdownCompleted = false;

    const bootstrapGate = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });

    const gateway = startGateway({
      app: {
        fetch: () => new Response("ok"),
      },
      port: 7899,
      outboxWorker: {
        start: () => {
          events.push("outbox:start");
        },
        stop: async () => {
          events.push("outbox:stop");
        },
      } as OutboxWorker,
      runtimeBootstrapper: {
        bootstrap: async () => {
          events.push("bootstrap:start");
          await bootstrapGate;
          events.push("bootstrap:done");
        },
        shutdown: async () => {
          events.push("bootstrap:shutdown");
        },
      } as unknown as RuntimeBootstrapper,
      logger: {
        info: () => {},
        error: () => {},
      },
      serve: (_options, onListening) => {
        events.push("http:serve");
        onListening?.({ port: 7899 } as never);
        return {
          close: () => {
            events.push("http:close");
          },
        } as never;
      },
    });

    await waitFor(() => events.includes("bootstrap:start"));

    const shutdownPromise = gateway.shutdown().then(() => {
      shutdownCompleted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shutdownCompleted, false);

    resolveBootstrap();
    await shutdownPromise;

    assert.ok(events.includes("bootstrap:done"));
    assert.ok(events.includes("bootstrap:shutdown"));
    assert.ok(events.includes("outbox:stop"));
    assert.ok(events.includes("http:close"));
  });
});

describe("runtime bootstrapper", () => {
  test("runtime bootstrapper retries after bootstrap rejection", async () => {
    const { RuntimeBootstrapper } = await import(
      "../runtime/runtime-bootstrapper.js"
    );
    let relayBootstrapAttempts = 0;
    let relayShutdownCalls = 0;

    const bootstrapper = new RuntimeBootstrapper(
      buildGatewayConfig({
        port: 7900,
        clusterMode: true,
        nodeId: "node-runtime-bootstrapper",
        nodeDisplayName: "Runtime Bootstrapper Node",
        runtimeAddress: "http://localhost:7900",
      }),
      {
        upsert: async () => {},
      } as never,
      {
        bootstrap: async () => {
          relayBootstrapAttempts += 1;
          if (relayBootstrapAttempts === 1) {
            throw new Error("bootstrap rejection");
          }
        },
        shutdown: async () => {
          relayShutdownCalls += 1;
        },
      } as RelayRuntime,
      {
        reconcile: async () => {},
      } as unknown as RuntimeAssignmentCoordinator,
      new DomainEventBus(),
    );

    await assert.rejects(bootstrapper.bootstrap(), /bootstrap rejection/);
    await bootstrapper.bootstrap();
    await bootstrapper.shutdown();

    assert.equal(relayBootstrapAttempts, 2);
    assert.equal(relayShutdownCalls, 1);
  });
});

describe("RelayRuntime node state snapshots", () => {
  class ConnectedPluginHostProvider extends PluginHostProvider {
    override create() {
      return {
        startChannelBinding: async (
          _binding: unknown,
          signal: AbortSignal,
          callbacks?: { onStatus?: (status: { connected?: boolean; running?: boolean }) => void },
        ) => {
          callbacks?.onStatus?.({ connected: true, running: true });
          await new Promise<void>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      } as ReturnType<PluginHostProvider["create"]>;
    }
  }

  class TrackingRelayRuntimeAssemblyProvider extends RelayRuntimeAssemblyProvider {
    createCalls = 0;

    override create(
      ...args: Parameters<RelayRuntimeAssemblyProvider["create"]>
    ) {
      this.createCalls += 1;
      return super.create(...args);
    }
  }

  class ControlledAsyncNodeRuntimeStateStore implements NodeRuntimeStateStore {
    private readonly committedSnapshots: LocalRuntimeSnapshot[] = [];
    private readonly pendingSnapshots: Array<{
      resolve: () => void;
      snapshot: LocalRuntimeSnapshot;
    }> = [];

    async publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void> {
      await new Promise<void>((resolve) => {
        this.pendingSnapshots.push({
          resolve,
          snapshot: cloneRuntimeSnapshot(snapshot),
        });
      });
      this.committedSnapshots.push(cloneRuntimeSnapshot(snapshot));
    }

    async waitForPending(count: number): Promise<void> {
      await waitFor(() => this.pendingSnapshots.length >= count);
    }

    async waitForCommitted(count: number): Promise<void> {
      await waitFor(() => this.committedSnapshots.length >= count);
    }

    getPendingCount(): number {
      return this.pendingSnapshots.length;
    }

    releasePending(index: number): void {
      const entry = this.pendingSnapshots[index];
      assert.ok(entry, `pending snapshot ${index} should exist`);
      entry.resolve();
      this.pendingSnapshots.splice(index, 1);
    }

    listCommittedSnapshots(): LocalRuntimeSnapshot[] {
      return this.committedSnapshots.map(cloneRuntimeSnapshot);
    }
  }

  test("publishes node lifecycle snapshots through an injected state store", async () => {
    const config = buildGatewayConfig({
      clusterMode: false,
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7890",
    });
    const stateStore = new LocalNodeRuntimeStateStore();
    const pluginHostProvider = new PluginHostProvider();
    const transportRegistryProvider = new TransportRegistryProvider([
      {
        protocol: "a2a",
        send: async () => ({ text: "" }),
      },
    ]);
    const agentClientRegistry = new AgentClientRegistry(transportRegistryProvider);
    const runtime = createRelayRuntime({
      config,
      stateStore,
      pluginHostProvider,
      agentClientRegistry,
    });

    await runtime.bootstrap();
    await runtime.shutdown();

    const snapshots = stateStore.listNodeSnapshots().reverse();

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.lifecycle),
      ["bootstrapping", "ready", "stopping", "stopped"],
    );

    for (const snapshot of snapshots) {
      assert.equal(snapshot.nodeId, "node-a");
      assert.equal(snapshot.displayName, "Node A");
      assert.equal(snapshot.mode, "local");
      assert.equal(snapshot.lastKnownAddress, "http://127.0.0.1:7890");
      assert.deepEqual(snapshot.bindingStatuses, []);
      assert.match(snapshot.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("bootstrap does not reassemble the plugin runtime or host", async () => {
    const config = buildGatewayConfig({
      clusterMode: false,
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7890",
    });
    const stateStore = new LocalNodeRuntimeStateStore();
    const pluginHostProvider = new PluginHostProvider();
    const connectionManagerProvider = new ConnectionManagerProvider();
    const assemblyProvider = new TrackingRelayRuntimeAssemblyProvider(
      pluginHostProvider,
      connectionManagerProvider,
    );
    const runtime = createRelayRuntime({
      config,
      stateStore,
      assemblyProvider,
    });

    assert.equal(assemblyProvider.createCalls, 1);

    await runtime.bootstrap();

    assert.equal(assemblyProvider.createCalls, 1);
  });

  test("publishes a stopped snapshot without active binding statuses on shutdown", async () => {
    const config = buildGatewayConfig({
      clusterMode: false,
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7890",
    });
    const stateStore = new LocalNodeRuntimeStateStore();
    const transportRegistryProvider = new TransportRegistryProvider([
      {
        protocol: "a2a",
        send: async () => ({ text: "" }),
      },
    ]);
    const agentClientRegistry = new AgentClientRegistry(transportRegistryProvider);
    const runtime = createRelayRuntime({
      config,
      stateStore,
      pluginHostProvider: new ConnectedPluginHostProvider(),
      agentClientRegistry,
    });
    const agent = {
      id: "agent-1",
      name: "Agent One",
      url: "http://agent-1",
      protocol: "a2a" as const,
      createdAt: new Date().toISOString(),
    };
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: agent.id,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    await runtime.attachBinding(binding, agent);
    await waitFor(() =>
      stateStore
        .listNodeSnapshots()
        .some(
          (snapshot) =>
            snapshot.lifecycle === "stopped" ||
            snapshot.bindingStatuses.some(
              (status) =>
                status.bindingId === binding.id && status.status === "connected",
            ),
        ),
    );
    await runtime.shutdown();

    const snapshots = stateStore.listNodeSnapshots().reverse();
    const stoppingSnapshot = snapshots.at(-2);
    const stoppedSnapshot = snapshots.at(-1);

    assert.equal(stoppingSnapshot?.lifecycle, "stopping");
    assert.deepEqual(stoppingSnapshot?.bindingStatuses, [
      {
        bindingId: binding.id,
        status: "connected",
        agentUrl: agent.url,
        error: undefined,
        updatedAt: stoppingSnapshot?.bindingStatuses[0]?.updatedAt,
      },
    ]);
    assert.equal(stoppedSnapshot?.lifecycle, "stopped");
    assert.deepEqual(stoppedSnapshot?.bindingStatuses, []);
  });

  test("serializes async state store publications for owned connection status updates", async () => {
    const config = buildGatewayConfig({
      clusterMode: false,
      nodeId: "node-a",
      nodeDisplayName: "Node A",
      runtimeAddress: "http://127.0.0.1:7890",
    });
    const stateStore = new ControlledAsyncNodeRuntimeStateStore();
    const runtimeNodeState = new RuntimeNodeState(config);
    const runtime = createRelayRuntime({
      config,
      stateStore,
      runtimeNodeState,
      agentClientRegistry: new AgentClientRegistry(
        new TransportRegistryProvider([
          {
            protocol: "a2a",
            send: async () => ({ text: "" }),
          },
        ]),
      ),
    });
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const relayRuntime = runtime as unknown as {
      applyOwnedConnectionStatus(
        bindingId: string,
        status: "connecting" | "connected" | "disconnected" | "error" | "idle",
        agentUrl?: string,
        error?: unknown,
      ): void;
      bindingsById: Map<string, typeof binding>;
    };

    relayRuntime.bindingsById.set(binding.id, binding);
    relayRuntime.applyOwnedConnectionStatus(binding.id, "connecting", "http://agent-1");
    await stateStore.waitForPending(1);

    relayRuntime.applyOwnedConnectionStatus(binding.id, "connected", "http://agent-1");
    assert.equal(stateStore.getPendingCount(), 1);

    stateStore.releasePending(0);
    await stateStore.waitForPending(1);
    stateStore.releasePending(0);
    await stateStore.waitForCommitted(2);

    assert.deepEqual(
      stateStore
        .listCommittedSnapshots()
        .map((snapshot) => snapshot.bindingStatuses[0]?.status),
      ["connecting", "connected"],
    );
  });
});

function cloneRuntimeSnapshot(snapshot: LocalRuntimeSnapshot): LocalRuntimeSnapshot {
  return {
    ...snapshot,
    bindingStatuses: snapshot.bindingStatuses.map((status) => ({ ...status })),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("RelayRuntime ownership semantics", () => {
  const testTransport = {
    protocol: "a2a",
    send: async () => ({ text: "" }),
  };

  const createBinding = (overrides: Partial<ReturnType<typeof createBindingBase>> = {}) => ({
    ...createBindingBase(),
    ...overrides,
  });

  function createBindingBase() {
    return {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };
  }

  const createAgent = () => ({
    id: "agent-1",
    name: "Agent One",
    url: "http://agent-1",
    protocol: "a2a",
    createdAt: new Date().toISOString(),
  });

  type RelayRuntimeHarness = {
    attachBinding: RelayRuntime["attachBinding"];
    assignBinding: RelayRuntime["assignBinding"];
    refreshBinding: RelayRuntime["refreshBinding"];
    detachBinding: RelayRuntime["detachBinding"];
    releaseBinding: RelayRuntime["releaseBinding"];
    hasActiveConnection: RelayRuntime["hasActiveConnection"];
    listBindings: RelayRuntime["listBindings"];
    listConnectionStatuses: RelayRuntime["listConnectionStatuses"];
    connectionManager: RelayRuntime["connectionManager"] & {
      restartConnection(binding: { id: string }): Promise<void>;
      stopConnection(bindingId: string): Promise<void>;
    };
  };

  type RelayRuntimeLifecycleHarness = RelayRuntimeHarness & {
    ownershipState: {
      markDisconnected(
        bindingId: string,
        agentUrl?: string,
      ): { attempt: number; delayMs: number };
    };
    pluginHost: {
      startChannelBinding(
        binding: { id: string },
        signal: AbortSignal,
        callbacks?: {
          onStatus?: (status: {
            running?: boolean;
            connected?: boolean;
          }) => void;
        },
      ): Promise<void>;
    };
  };

  const createRelayRuntimeForTest = (hooks?: {
    restartConnection?: (binding: { id: string }) => Promise<void>;
    stopConnection?: (bindingId: string) => Promise<void>;
  }) => {
    const runtime = createRelayRuntime({
      transports: [testTransport],
    }) as unknown as RelayRuntimeHarness;
    runtime.connectionManager.restartConnection =
      hooks?.restartConnection ?? (async () => {});
    runtime.connectionManager.stopConnection =
      hooks?.stopConnection ?? (async () => {});
    return runtime;
  };

  const createRelayRuntimeWithLifecycle = (transport = testTransport) => {
    const runtime = createRelayRuntime({
      transports: [transport],
    }) as unknown as RelayRuntimeLifecycleHarness;
    const lifetimes: Array<{ resolve: () => void }> = [];

    runtime.pluginHost.startChannelBinding = async (
      _binding: { id: string },
      signal: AbortSignal,
      callbacks?: {
        onStatus?: (status: {
          running?: boolean;
          connected?: boolean;
        }) => void;
      },
    ) =>
      new Promise<void>((resolve, reject) => {
        callbacks?.onStatus?.({
          running: true,
          connected: true,
        });

        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          const error = new Error("Aborted");
          Object.assign(error, { name: "AbortError" });
          reject(error);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        lifetimes.push({
          resolve: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        });
      });

    return { runtime, lifetimes };
  };

  const createDispatchEvent = () =>
    ({
      type: "channel.reply.dispatch",
      ctx: {
        BodyForAgent: "hello",
        ChannelType: "feishu",
        AccountId: "default",
      },
      dispatcher: {
        sendFinalReply() {},
        waitForIdle: async () => {},
        markComplete() {},
      },
    }) as const;

  test("refreshing an unchanged binding with no active connection restarts it", async () => {
    const restartCalls: string[] = [];
    const runtime = createRelayRuntimeForTest({
      restartConnection: async (binding) => {
        restartCalls.push(binding.id);
      },
    });
    const binding = createBinding();
    const agent = createAgent();

    await runtime.attachBinding(binding, agent);
    await runtime.refreshBinding(binding, agent);

    assert.deepEqual(restartCalls, ["binding-1", "binding-1"]);
  });

  test("detaching a binding removes it from runtime connection statuses", async () => {
    const runtime = createRelayRuntimeForTest();
    const binding = createBinding();
    const agent = createAgent();

    await runtime.attachBinding(binding, agent);
    await runtime.detachBinding(binding.id);

    assert.deepEqual(runtime.listConnectionStatuses(), []);
  });

  test("binding lifecycle callbacks promote a healthy start to connected before disconnect", async () => {
    const { runtime, lifetimes } = createRelayRuntimeWithLifecycle();
    const binding = createBinding();
    const agent = createAgent();

    await runtime.attachBinding(binding, agent);
    assert.equal(runtime.listConnectionStatuses()[0]?.status, "connected");

    lifetimes[0]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(runtime.listConnectionStatuses()[0]?.status, "disconnected");
  });

  test("managed refresh does not burn reconnect attempts on the intentional abort", async () => {
    const { runtime } = createRelayRuntimeWithLifecycle();
    const binding = createBinding();
    const agent = createAgent();

    await runtime.attachBinding(binding, agent);
    assert.equal(runtime.listConnectionStatuses()[0]?.status, "connected");

    await runtime.refreshBinding(binding, agent);
    assert.equal(runtime.listConnectionStatuses()[0]?.status, "connected");

    const retry = runtime.ownershipState.markDisconnected(binding.id, agent.url);
    assert.equal(retry.attempt, 1);
  });

  test("agent send failures do not overwrite connection ownership status", async () => {
    const failingTransport = {
      protocol: "a2a",
      send: async () => {
        throw new Error("agent send failed");
      },
    };
    const { runtime } = createRelayRuntimeWithLifecycle(failingTransport);
    const binding = createBinding();
    const agent = createAgent();

    await runtime.attachBinding(binding, agent);
    await assert.rejects(
      runtime.connectionManager.handleEvent(createDispatchEvent() as never),
      /agent send failed/,
    );

    assert.equal(runtime.listConnectionStatuses()[0]?.status, "connected");
  });

  test("refreshing a binding into a non-runnable state clears active-looking ownership status", async () => {
    const { runtime } = createRelayRuntimeWithLifecycle();
    const binding = createBinding();
    const agent = createAgent();

    await runtime.attachBinding(binding, agent);
    assert.equal(runtime.listConnectionStatuses()[0]?.status, "connected");

    await runtime.refreshBinding(
      createBinding({
        channelConfig: { appId: "cli_1", appSecret: "" },
      }),
      agent,
    );

    assert.equal(runtime.listConnectionStatuses()[0]?.status, "idle");
  });

  test("refreshing a binding after its agent changes restarts it only once", async () => {
    const restartCalls: string[] = [];
    const runtime = createRelayRuntimeForTest({
      restartConnection: async (binding) => {
        restartCalls.push(binding.id);
      },
    });
    const binding = createBinding();
    const agent = createAgent();
    const updatedAgent = {
      ...agent,
      url: "http://agent-2",
    };

    await runtime.attachBinding(binding, agent);
    await runtime.refreshBinding(binding, updatedAgent);

    assert.deepEqual(restartCalls, ["binding-1", "binding-1"]);
  });

  test("assignBinding seeds a new binding and releaseBinding removes it", async () => {
    const runtime = createRelayRuntimeForTest();
    const binding = createBinding();
    const agent = createAgent();

    await runtime.assignBinding(binding, agent);
    assert.equal(
      runtime.listBindings().some((item) => item.id === binding.id),
      true,
    );

    await runtime.releaseBinding(binding.id);
    assert.equal(
      runtime.listBindings().some((item) => item.id === binding.id),
      false,
    );
  });
});

describe("RelayRuntime reconnect policy", () => {
  const createBinding = () => ({
    id: "binding-1",
    name: "Binding One",
    channelType: "feishu",
    accountId: "default",
    channelConfig: { appId: "cli_1", appSecret: "sec_1" },
    agentId: "agent-1",
    enabled: true,
    createdAt: new Date().toISOString(),
  });

  const createAgent = () => ({
    id: "agent-1",
    name: "Agent One",
    url: "http://agent-1",
    protocol: "a2a",
    createdAt: new Date().toISOString(),
  });

  type RelayRuntimeReconnectHarness = {
    attachBinding: RelayRuntime["attachBinding"];
    hasActiveConnection: RelayRuntime["hasActiveConnection"];
    connectionManager: RelayRuntime["connectionManager"] & {
      restartConnection(binding: { id: string }): Promise<void>;
    };
    applyOwnedConnectionStatus(
      bindingId: string,
      status: "error" | "disconnected" | "connecting" | "connected",
      agentUrl?: string,
      error?: unknown,
    ): void;
  };

  test("connection error schedules one delayed reconnect for the owned binding", async () => {
    const restartCalls: string[] = [];
    const runtime = createRelayRuntime({
      reconnectPolicy: createReconnectPolicy({ baseDelayMs: 1, maxDelayMs: 1 }),
      transports: [{ protocol: "a2a", send: async () => ({ text: "" }) }],
    }) as unknown as RelayRuntimeReconnectHarness;
    const binding = createBinding();
    const agent = createAgent();

    runtime.connectionManager.restartConnection = async (nextBinding) => {
      restartCalls.push(nextBinding.id);
    };

    await runtime.attachBinding(binding, agent);
    runtime.applyOwnedConnectionStatus(
      binding.id,
      "error",
      agent.url,
      new Error("boom"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(restartCalls, ["binding-1", "binding-1"]);
  });
});
// ---------------------------------------------------------------------------

describe("Agent CRUD", () => {
  beforeEach(resetDB);

  test("create stores all fields and returns a mapped agent", async () => {
    const agent = await createAgentConfig(AGENT_DATA);

    assert.ok(agent.id, "id should be non-empty");
    assert.equal(agent.name, AGENT_DATA.name);
    assert.equal(agent.url, AGENT_DATA.url);
    assert.equal(agent.protocol, AGENT_DATA.protocol);
    assert.equal(agent.description, AGENT_DATA.description);
    assert.ok(agent.createdAt, "createdAt should be set");
  });

  test("create defaults protocol to 'a2a' when not provided", async () => {
    const agent = await createAgentConfig({
      name: "No Protocol",
      url: "http://no-proto:3000",
    });
    assert.equal(agent.protocol, "a2a");
  });

  test("create handles undefined description", async () => {
    const agent = await createAgentConfig({
      name: "No Desc",
      url: "http://no-desc:3000",
    });
    assert.equal(agent.description, undefined);
  });

  test("list returns empty array when no agents exist", async () => {
    const list = await listAgentConfigs();
    assert.deepEqual(list, []);
  });

  test("list returns all agents ordered by createdAt asc", async () => {
    const a1 = await createAgentConfig({ ...AGENT_DATA, name: "First" });
    const a2 = await createAgentConfig({
      ...AGENT_DATA,
      url: "http://second:3002",
      name: "Second",
    });

    const list = await listAgentConfigs();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, a1.id);
    assert.equal(list[1]?.id, a2.id);
  });

  test("get returns null for an unknown id", async () => {
    const result = await getAgentConfig("nonexistent-id");
    assert.equal(result, null);
  });

  test("get returns the agent for a known id", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    const fetched = await getAgentConfig(created.id);

    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, created.name);
  });

  test("update returns null for an unknown id", async () => {
    const result = await updateAgentConfig("nonexistent-id", {
      name: "New Name",
    });
    assert.equal(result, null);
  });

  test("update patches only the provided fields", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    const updated = await updateAgentConfig(created.id, {
      name: "Updated Agent",
      protocol: "acp",
    });

    assert.ok(updated);
    assert.equal(updated.name, "Updated Agent");
    assert.equal(updated.protocol, "acp");
    // Unchanged
    assert.equal(updated.url, AGENT_DATA.url);
  });

  test("update persists changes to the database", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    await updateAgentConfig(created.id, { name: "DB Persisted Agent" });
    const fetched = await getAgentConfig(created.id);

    assert.ok(fetched);
    assert.equal(fetched.name, "DB Persisted Agent");
  });

  test("update handles URL change in DB-backed protocol lookup", async () => {
    const created = await createAgentConfig({
      ...AGENT_DATA,
      url: "http://old-url:3001",
      protocol: "acp",
    });

    assert.equal(await getAgentProtocolForUrl("http://old-url:3001"), "acp");

    await updateAgentConfig(created.id, { url: "http://new-url:3001" });

    assert.equal(await getAgentProtocolForUrl("http://old-url:3001"), "a2a");
    assert.equal(await getAgentProtocolForUrl("http://new-url:3001"), "acp");
  });

  test("delete returns false for an unknown id", async () => {
    const result = await deleteAgentConfig("nonexistent-id");
    assert.equal(result, false);
  });

  test("delete removes the agent and returns true", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    const deleted = await deleteAgentConfig(created.id);

    assert.equal(deleted, true);
    const fetched = await getAgentConfig(created.id);
    assert.equal(fetched, null);
  });

  test("delete removes the agent from DB-backed protocol lookup", async () => {
    const created = await createAgentConfig({
      ...AGENT_DATA,
      protocol: "acp",
    });
    assert.equal(await getAgentProtocolForUrl(created.url), "acp");

    await deleteAgentConfig(created.id);
    assert.equal(await getAgentProtocolForUrl(created.url), "a2a");
  });
});

// ---------------------------------------------------------------------------
// Agent routing
// ---------------------------------------------------------------------------

describe("agent routing", () => {
  beforeEach(resetDB);

  const DEFAULT_URL = "http://default-agent:3001";

  test("getAgentUrlForBinding returns the default URL when the binding is missing", async () => {
    const url = await getAgentUrlForBinding("missing-binding", DEFAULT_URL);
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForBinding returns the matching enabled binding URL", async () => {
    const agent = await createTestAgent("http://binding-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      agentId: agent.id,
    });

    const url = await getAgentUrlForBinding(binding.id, DEFAULT_URL);
    assert.equal(url, agent.url);
  });

  test("getAgentUrlForBinding skips disabled bindings", async () => {
    const agent = await createTestAgent("http://disabled-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      agentId: agent.id,
      enabled: false,
    });

    const url = await getAgentUrlForBinding(binding.id, DEFAULT_URL);
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount returns the matching channel/account URL", async () => {
    const agent = await createTestAgent("http://exact-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "exact-match",
      agentId: agent.id,
    });

    const url = await getAgentUrlForChannelAccount(
      "feishu",
      "exact-match",
      DEFAULT_URL,
    );
    assert.equal(url, agent.url);
  });

  test("getAgentUrlForChannelAccount does not fall back to another account", async () => {
    const agent = await createTestAgent("http://other-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "other-account",
      agentId: agent.id,
    });

    const url = await getAgentUrlForChannelAccount(
      "feishu",
      "no-match-account",
      DEFAULT_URL,
    );
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount skips disabled bindings", async () => {
    const agent = await createTestAgent("http://disabled-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "disabled-account",
      agentId: agent.id,
      enabled: false,
    });

    const url = await getAgentUrlForChannelAccount(
      "feishu",
      "disabled-account",
      DEFAULT_URL,
    );
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount treats undefined channel/account as feishu/default", async () => {
    const agent = await createTestAgent("http://default-binding-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "default",
      agentId: agent.id,
    });

    const url = await getAgentUrlForChannelAccount(undefined, undefined, DEFAULT_URL);
    assert.equal(url, agent.url);
  });

  test("getAgentUrlForChannelAccount distinguishes identical accountIds across channel types", async () => {
    const feishuAgent = await createTestAgent("http://feishu-agent:4000");
    const slackAgent = await createTestAgent("http://slack-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "shared",
      agentId: feishuAgent.id,
    });
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Slack Bot",
      channelType: "slack",
      accountId: "shared",
      channelConfig: { token: "xoxb" },
      agentId: slackAgent.id,
    });

    assert.equal(
      await getAgentUrlForChannelAccount("feishu", "shared", DEFAULT_URL),
      feishuAgent.url,
    );
    assert.equal(
      await getAgentUrlForChannelAccount("slack", "shared", DEFAULT_URL),
      slackAgent.url,
    );
  });
});

// ---------------------------------------------------------------------------
// getAgentProtocolForUrl
// ---------------------------------------------------------------------------

describe("getAgentProtocolForUrl", () => {
  beforeEach(resetDB);

  test("returns 'a2a' when the agent is not in the database", async () => {
    const protocol = await getAgentProtocolForUrl("http://unknown:3001");
    assert.equal(protocol, "a2a");
  });

  test("returns the stored protocol for an agent", async () => {
    await createAgentConfig({
      name: "ACP Agent",
      url: "http://acp-agent:3001",
      protocol: "acp",
    });

    const protocol = await getAgentProtocolForUrl("http://acp-agent:3001");
    assert.equal(protocol, "acp");
  });

  test("returns 'a2a' after the agent is deleted", async () => {
    const agent = await createAgentConfig({
      name: "Temp Agent",
      url: "http://temp:3001",
      protocol: "acp",
    });
    await deleteAgentConfig(agent.id);

    const protocol = await getAgentProtocolForUrl("http://temp:3001");
    assert.equal(protocol, "a2a");
  });
});

// ---------------------------------------------------------------------------
// buildOpenClawConfig
// ---------------------------------------------------------------------------

describe("buildOpenClawConfig", () => {
  beforeEach(resetDB);

  test("returns an empty feishu config when there are no bindings", async () => {
    const config = await buildOpenClawConfig();

    assert.deepEqual(config.channels, {
      feishu: {},
      feishu_doc: {},
    });
    assert.deepEqual(config.agents, {});
  });

  test("returns feishu config for a 'default' account binding", async () => {
    const agent = await createTestAgent("http://localhost:3001");
    const binding = await createChannelBinding({
      name: "Default Feishu",
      channelType: "feishu",
      accountId: "default",
      channelConfig: {
        appId: "cli_def",
        appSecret: "sec_def",
        verificationToken: "token123",
        encryptKey: "enc456",
        allowFrom: ["*"],
      },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = config.channels as Record<string, unknown>;
    const feishuConfig = feishu["feishu"] as Record<string, unknown>;

    assert.equal(feishuConfig["bindingId"], binding.id);
    assert.equal(feishuConfig["agentUrl"], agent.url);
    assert.equal(feishuConfig["appId"], "cli_def");
    assert.equal(feishuConfig["appSecret"], "sec_def");
    assert.equal(feishuConfig["verificationToken"], "token123");
    assert.equal(feishuConfig["encryptKey"], "enc456");
    assert.equal(feishuConfig["enabled"], true);
    assert.deepEqual(feishuConfig["allowFrom"], ["*"]);
    assert.ok(!("accounts" in feishuConfig), "default account should not create accounts block");
  });

  test("returns feishu config with an accounts block for non-default bindings", async () => {
    const agent = await createTestAgent("http://localhost:3001");
    const binding = await createChannelBinding({
      name: "Account A",
      channelType: "feishu",
      accountId: "account-a",
      channelConfig: { appId: "cli_a", appSecret: "sec_a" },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;
    const accounts = feishu["accounts"] as Record<string, unknown>;

    assert.ok(accounts);
    assert.ok("account-a" in accounts);
    const accountCfg = accounts["account-a"] as Record<string, unknown>;
    assert.equal(accountCfg["bindingId"], binding.id);
    assert.equal(accountCfg["agentUrl"], agent.url);
    assert.equal(accountCfg["appId"], "cli_a");
  });

  test("skips disabled feishu bindings", async () => {
    const agent = await createTestAgent();
    await createChannelBinding({
      name: "Disabled Bot",
      channelType: "feishu",
      accountId: "disabled",
      channelConfig: { appId: "cli_dis", appSecret: "sec_dis" },
      agentId: agent.id,
      enabled: false,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;

    assert.ok(
      !("appId" in feishu) && !("accounts" in feishu),
      "disabled binding should not appear in config",
    );
  });

  test("skips non-feishu channel bindings", async () => {
    const agent = await createTestAgent();
    await createChannelBinding({
      name: "Slack Bot",
      channelType: "slack",
      accountId: "default",
      channelConfig: { token: "xoxb-slack" },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;

    assert.ok(
      !("appId" in feishu),
      "slack binding should not appear in feishu config",
    );
  });

  test("uses '*' as default allowFrom when not specified in channelConfig", async () => {
    const agent = await createTestAgent();
    await createChannelBinding({
      name: "No AllowFrom",
      channelType: "feishu",
      accountId: "no-allow",
      channelConfig: { appId: "cli_naf", appSecret: "sec_naf" },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;
    const accounts = feishu["accounts"] as Record<string, unknown>;
    const accountCfg = accounts["no-allow"] as Record<string, unknown>;

    assert.deepEqual(accountCfg["allowFrom"], ["*"]);
  });
});

// ---------------------------------------------------------------------------
// seedDefaults
// ---------------------------------------------------------------------------

describe("seedDefaults", () => {
  beforeEach(resetDB);

  const ECHO_URL = "http://localhost:3001";

  test("creates the echo agent when the agents table is empty", async () => {
    await seedDefaults();

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.equal(agent.url, ECHO_URL);
    assert.equal(agent.protocol, "a2a");
  });

  test("does not duplicate the echo agent on repeated calls", async () => {
    await seedDefaults();
    await seedDefaults();

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
  });

  test("does not create echo agent when agents already exist", async () => {
    await createAgentConfig({
      name: "Existing Agent",
      url: "http://existing:4000",
      protocol: "a2a",
    });

    await seedDefaults();

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.url, "http://existing:4000");
  });

  test("seeded echo agent is available to protocol lookup", async () => {
    await seedDefaults();
    const protocol = await getAgentProtocolForUrl(ECHO_URL);
    assert.equal(protocol, "a2a");
  });

  test("creates a feishu binding from FEISHU_APP_ID / FEISHU_APP_SECRET env vars", async () => {
    process.env["FEISHU_APP_ID"] = "cli_seed_app";
    process.env["FEISHU_APP_SECRET"] = "seed_secret";
    process.env["FEISHU_ACCOUNT_ID"] = "seed-account";

    try {
      await seedDefaults();

      const bindings = await listChannelBindings();
      const feishuBinding = bindings.find(
        (b) => b.channelType === "feishu" && b.accountId === "seed-account",
      );

      assert.ok(feishuBinding, "feishu binding should be created from env vars");
      const cfg = feishuBinding.channelConfig as Record<string, unknown>;
      assert.equal(cfg["appId"], "cli_seed_app");
      assert.equal(cfg["appSecret"], "seed_secret");
    } finally {
      delete process.env["FEISHU_APP_ID"];
      delete process.env["FEISHU_APP_SECRET"];
      delete process.env["FEISHU_ACCOUNT_ID"];
    }
  });

  test("does not duplicate the feishu binding on repeated seedDefaults calls", async () => {
    process.env["FEISHU_APP_ID"] = "cli_dup";
    process.env["FEISHU_APP_SECRET"] = "dup_secret";
    process.env["FEISHU_ACCOUNT_ID"] = "dup-account";

    try {
      await seedDefaults();
      await seedDefaults();

      const bindings = await listChannelBindings();
      const feishuBindings = bindings.filter(
        (b) => b.channelType === "feishu" && b.accountId === "dup-account",
      );
      assert.equal(feishuBindings.length, 1);
    } finally {
      delete process.env["FEISHU_APP_ID"];
      delete process.env["FEISHU_APP_SECRET"];
      delete process.env["FEISHU_ACCOUNT_ID"];
    }
  });

  test("uses 'default' as accountId when FEISHU_ACCOUNT_ID is not set", async () => {
    process.env["FEISHU_APP_ID"] = "cli_noaccountid";
    process.env["FEISHU_APP_SECRET"] = "sec_noaccountid";
    delete process.env["FEISHU_ACCOUNT_ID"];

    try {
      await seedDefaults();

      const bindings = await listChannelBindings();
      const feishuBinding = bindings.find(
        (b) => b.channelType === "feishu" && b.accountId === "default",
      );
      assert.ok(feishuBinding, "accountId should default to 'default'");
    } finally {
      delete process.env["FEISHU_APP_ID"];
      delete process.env["FEISHU_APP_SECRET"];
    }
  });
});

// ---------------------------------------------------------------------------
// initStore
// ---------------------------------------------------------------------------

describe("initStore", () => {
  beforeEach(resetDB);

  test("recreates the runtime_nodes table when it is missing", async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "runtime_nodes"');

    await initStore();

    await prisma.runtimeNode.create({
      data: {
        nodeId: "node-recreated",
        displayName: "Recreated Node",
        mode: "local",
        lastKnownAddress: "http://localhost:7890",
      },
    });

    const found = await prisma.runtimeNode.findUnique({
      where: { nodeId: "node-recreated" },
    });

    assert.ok(found);
    assert.equal(found?.displayName, "Recreated Node");
  });

  test("direct channel rows are available through DB-backed routing", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: "Direct Binding Agent",
        url: "http://direct:4000",
        protocol: "a2a",
      },
    });

    await prisma.channelBinding.create({
      data: {
        name: "Direct Insert",
        channelType: "feishu",
        accountId: "direct",
        channelConfig: JSON.stringify({ appId: "x", appSecret: "y" }),
        agentId: agent.id,
        enabled: true,
      },
    });

    const bindings = await listChannelBindings();
    const binding = bindings.find((b) => b.accountId === "direct");
    assert.ok(binding);

    const url = await getAgentUrlForBinding(binding.id, "http://fallback");
    assert.equal(url, "http://direct:4000");
  });

  test("direct agent rows are available through DB-backed protocol lookup", async () => {
    // Insert directly via prisma
    await prisma.agent.create({
      data: {
        name: "Direct Agent",
        url: "http://direct-agent:4000",
        protocol: "acp",
      },
    });

    const protocol = await getAgentProtocolForUrl("http://direct-agent:4000");
    assert.equal(protocol, "acp");
  });
});

// ---------------------------------------------------------------------------
// DDD state persistence – aggregates + application services + outbox
// ---------------------------------------------------------------------------

describe("LocalScheduler", () => {
  test("start and stop do not accumulate duplicate event listeners", async () => {
    const bus = new DomainEventBus();
    let reconcileCalls = 0;
    const coordinator = {
      reconcile: async () => {
        reconcileCalls += 1;
      },
    };

    const scheduler = new LocalScheduler(
      coordinator as unknown as RuntimeAssignmentCoordinator,
      bus,
      {
        debounceMs: 0,
        reconcileIntervalMs: 60_000,
      },
    );

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduler.stop();
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    reconcileCalls = 0;

    bus.publish({
      eventType: "AgentDeleted.v1",
      agentId: "agent-1",
      occurredAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduler.stop();

    assert.ok(
      reconcileCalls <= 1,
      "scheduler should not reconcile twice for one event after restart",
    );
  });

  test("reconcile delegates directly to the coordinator", async () => {
    let reconcileCalls = 0;
    const scheduler = new LocalScheduler(
      {
        reconcile: async () => {
          reconcileCalls += 1;
        },
      } as unknown as RuntimeAssignmentCoordinator,
      new DomainEventBus(),
    );

    await scheduler.reconcile();

    assert.equal(reconcileCalls, 1);
  });
});

describe("RuntimeAssignmentCoordinator", () => {
  const createAgent = (id = "agent-1") => ({
    id,
    name: "Agent One",
    url: `http://${id}`,
    protocol: "a2a",
    createdAt: new Date().toISOString(),
  });

  test("reconciles runnable desired bindings and releases stale owned bindings", async () => {
    const events: string[] = [];
    const runtime = {
      listOwnedBindingIds: () => ["binding-stale", "binding-disabled"],
      assignBinding: async (binding: { id: string }) => {
        events.push(`assign:${binding.id}`);
      },
      releaseBinding: async (bindingId: string) => {
        events.push(`release:${bindingId}`);
      },
    };

    const coordinator = new RuntimeAssignmentCoordinator(
      runtime as unknown as RelayRuntime,
      {
        loadSnapshot: async () => ({
          bindings: [
            {
              id: "binding-1",
              name: "Binding One",
              channelType: "feishu",
              accountId: "default",
              channelConfig: { appId: "cli_1", appSecret: "sec_1" },
              agentId: "agent-1",
              enabled: true,
              createdAt: new Date().toISOString(),
            },
            {
              id: "binding-disabled",
              name: "Binding Disabled",
              channelType: "feishu",
              accountId: "default",
              channelConfig: { appId: "cli_1", appSecret: "sec_1" },
              agentId: "agent-1",
              enabled: false,
              createdAt: new Date().toISOString(),
            },
          ],
          agents: [createAgent()],
        }),
      },
    );

    await coordinator.reconcile();

    assert.deepEqual(events, [
      "release:binding-stale",
      "release:binding-disabled",
      "assign:binding-1",
    ]);
  });

  test("releases owned non-runnable bindings as stale", async () => {
    const events: string[] = [];
    const runtime = {
      listOwnedBindingIds: () => ["binding-invalid"],
      assignBinding: async (binding: { id: string }) => {
        events.push(`assign:${binding.id}`);
      },
      releaseBinding: async (bindingId: string) => {
        events.push(`release:${bindingId}`);
      },
    };

    const coordinator = new RuntimeAssignmentCoordinator(
      runtime as unknown as RelayRuntime,
      {
        loadSnapshot: async () => ({
          bindings: [
            {
              id: "binding-invalid",
              name: "Binding Invalid",
              channelType: "feishu",
              accountId: "default",
              channelConfig: { appId: "cli_1" },
              agentId: "agent-1",
              enabled: true,
              createdAt: new Date().toISOString(),
            },
            {
              id: "binding-1",
              name: "Binding One",
              channelType: "feishu",
              accountId: "default",
              channelConfig: { appId: "cli_1", appSecret: "sec_1" },
              agentId: "agent-1",
              enabled: true,
              createdAt: new Date().toISOString(),
            },
          ],
          agents: [createAgent()],
        }),
      },
    );

    await coordinator.reconcile();

    assert.deepEqual(events, [
      "release:binding-invalid",
      "assign:binding-1",
    ]);
  });
});
describe("OutboxWorker", () => {
  beforeEach(resetDB);

  test("publishes pending outbox events and marks them processed", async () => {
    const { bindingService } = makeInfra();
    await ensureTestAgent("http://worker-agent:3001", "http://worker-agent:3001");
    const binding = await bindingService.create({
      name: "Worker Feishu Bot",
      channelType: "feishu",
      accountId: "worker-test",
      channelConfig: { appId: "cli_worker", appSecret: "sec_worker" },
      agentId: "http://worker-agent:3001",
      enabled: true,
    });

    const bus = new DomainEventBus();
    const received: unknown[] = [];
    bus.on("ChannelBindingCreated.v1", (event) => received.push(event));

    await new OutboxWorker(bus).drain();

    assert.equal(received.length, 1);
    assert.equal(
      (received[0] as { bindingId?: string }).bindingId,
      binding.id,
    );

    const row = await prisma.outboxEvent.findFirst({
      where: { aggregateId: binding.id },
    });
    assert.ok(row?.processedAt);
  });
});

describe("ChannelBinding aggregate + ChannelBindingService", () => {
  beforeEach(resetDB);

  test("create rejects a missing agent id before writing the binding", async () => {
    const { bindingService } = makeInfra();

    await assert.rejects(
      () => bindingService.create({
        name: "Broken Binding",
        channelType: "feishu",
        accountId: "missing-agent",
        channelConfig: { appId: "cli_1", appSecret: "sec_1" },
        agentId: "missing-agent-id",
        enabled: true,
      }),
      /Agent missing-agent-id not found/,
    );
  });

  test("create persists binding and returns snapshot", async () => {
    const { bindingService } = makeInfra();
    await ensureTestAgent("http://es-agent:3001", "http://es-agent:3001");
    const binding = await bindingService.create({
      name: "ES Feishu Bot",
      channelType: "feishu",
      accountId: "es-test",
      channelConfig: { appId: "cli_es", appSecret: "sec_es" },
      agentId: "http://es-agent:3001",
      enabled: true,
    });

    assert.ok(binding.id, "id should be set");
    assert.equal(binding.name, "ES Feishu Bot");
    assert.equal(binding.channelType, "feishu");
    assert.equal(binding.accountId, "es-test");
    assert.equal(binding.enabled, true);
  });

  test("create writes a ChannelBindingCreated event to the outbox", async () => {
    const { bindingService } = makeInfra();
    await ensureTestAgent("http://outbox-agent:3001", "http://outbox-agent:3001");
    const binding = await bindingService.create({
      name: "Outbox Feishu Bot",
      channelType: "feishu",
      accountId: "outbox-test",
      channelConfig: { appId: "cli_outbox", appSecret: "sec_outbox" },
      agentId: "http://outbox-agent:3001",
      enabled: true,
    });

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: binding.id },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "ChannelBindingCreated.v1");
  });

  test("create persists current binding state", async () => {
    const { bindingService } = makeInfra();
    await ensureTestAgent("http://state-agent:3001", "http://state-agent:3001");
    const binding = await bindingService.create({
      name: "State Feishu Bot",
      channelType: "feishu",
      accountId: "state-test",
      channelConfig: { appId: "cli_state", appSecret: "sec_state" },
      agentId: "http://state-agent:3001",
      enabled: true,
    });

    const row = await prisma.channelBinding.findUnique({ where: { id: binding.id } });
    assert.ok(row);
    assert.equal(row.name, "State Feishu Bot");
    assert.equal(row.channelType, "feishu");
  });

  test("update persists changes through state repository", async () => {
    const { bindingService } = makeInfra();
    await ensureTestAgent("http://upd-agent:3001", "http://upd-agent:3001");
    const created = await bindingService.create({
      name: "Before Update",
      channelType: "feishu",
      accountId: "update-test",
      channelConfig: { appId: "cli_upd", appSecret: "sec_upd" },
      agentId: "http://upd-agent:3001",
      enabled: true,
    });

    const updated = await bindingService.update(created.id, {
      name: "After Update",
      enabled: false,
    });

    assert.ok(updated);
    assert.equal(updated.name, "After Update");
    assert.equal(updated.enabled, false);
    assert.equal(updated.channelType, "feishu");
  });

  test("update writes create and update events to the outbox", async () => {
    const { bindingService } = makeInfra();
    await ensureTestAgent("http://2e-agent:3001", "http://2e-agent:3001");
    const created = await bindingService.create({
      name: "Two Events",
      channelType: "feishu",
      accountId: "two-events",
      channelConfig: { appId: "cli_2e", appSecret: "sec_2e" },
      agentId: "http://2e-agent:3001",
      enabled: true,
    });

    await bindingService.update(created.id, { name: "Updated" });

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: created.id },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventType, "ChannelBindingCreated.v1");
    assert.equal(events[1]?.eventType, "ChannelBindingUpdated.v1");
  });

  test("delete marks binding as deleted and removes state row", async () => {
    const { bindingService, bindingRepo } = makeInfra();
    await ensureTestAgent("http://del-agent:3001", "http://del-agent:3001");
    const created = await bindingService.create({
      name: "To Delete",
      channelType: "feishu",
      accountId: "delete-test",
      channelConfig: { appId: "cli_del", appSecret: "sec_del" },
      agentId: "http://del-agent:3001",
      enabled: true,
    });

    const deleted = await bindingService.delete(created.id);
    assert.equal(deleted, true);

    const found = await bindingRepo.findById(created.id);
    assert.equal(found, null, "deleted binding should not be findable");
  });

  test("rejects creating a second enabled binding for the same channel/account", async () => {
    const { bindingService, agentService } = makeInfra();
    const agent = await agentService.register({
      name: "First Agent",
      url: "http://d1:3001",
      protocol: "a2a",
    });
    await bindingService.create({
      name: "First",
      channelType: "feishu",
      accountId: "dup-test",
      channelConfig: { appId: "cli_d1", appSecret: "sec_d1" },
      agentId: agent.id,
      enabled: true,
    });

    await assert.rejects(
      bindingService.create({
        name: "Duplicate",
        channelType: "feishu",
        accountId: "dup-test",
        channelConfig: { appId: "cli_d2", appSecret: "sec_d2" },
        agentId: agent.id,
        enabled: true,
      }),
      DuplicateEnabledBindingError,
    );
  });

  test("database constraints reject a second enabled binding for the same channel/account", async () => {
    const { agentService } = makeInfra();
    const agent = await agentService.register({
      name: "DB Agent",
      url: "http://db-agent:3001",
      protocol: "a2a",
    });

    await prisma.channelBinding.create({
      data: {
        name: "First",
        channelType: "feishu",
        accountId: "db-dup-test",
        channelConfig: JSON.stringify({ appId: "cli_db1", appSecret: "sec_db1" }),
        agentId: agent.id,
        enabled: true,
        enabledKey: "feishu:db-dup-test",
      },
    });

    await assert.rejects(
      prisma.channelBinding.create({
        data: {
          name: "Second",
          channelType: "feishu",
          accountId: "db-dup-test",
          channelConfig: JSON.stringify({ appId: "cli_db2", appSecret: "sec_db2" }),
          agentId: agent.id,
          enabled: true,
          enabledKey: "feishu:db-dup-test",
        },
      }),
    );
  });

  test("state table remains the source of truth on cold start", async () => {
    const { bindingService, bindingRepo } = makeInfra();
    await ensureTestAgent("http://cs-agent:3001", "http://cs-agent:3001");
    const created = await bindingService.create({
      name: "Cold Start Binding",
      channelType: "feishu",
      accountId: "cold-start",
      channelConfig: { appId: "cli_cs", appSecret: "sec_cs" },
      agentId: "http://cs-agent:3001",
      enabled: true,
    });

    const found = await bindingRepo.findById(created.id);
    assert.ok(found, "binding should load from the current state row");
    assert.equal(found.name, "Cold Start Binding");
  });
});

describe("AgentConfig aggregate + AgentService", () => {
  beforeEach(resetDB);

  test("register persists agent and returns snapshot", async () => {
    const { agentService } = makeInfra();
    const agent = await agentService.register({
      name: "ES Agent",
      url: "http://es-agent:4000",
      protocol: "a2a",
    });

    assert.ok(agent.id);
    assert.equal(agent.name, "ES Agent");
    assert.equal(agent.protocol, "a2a");
  });

  test("register does not write a runtime outbox event", async () => {
    const { agentService } = makeInfra();

    await agentService.register({
      name: "Bus Agent",
      url: "http://bus-agent:4000",
    });

    const events = await prisma.outboxEvent.findMany();
    assert.equal(events.length, 0);
  });

  test("update patches agent fields", async () => {
    const { agentService } = makeInfra();
    const created = await agentService.register({
      name: "Before",
      url: "http://before:4000",
      protocol: "a2a",
    });

    const updated = await agentService.update(created.id, {
      name: "After",
      protocol: "acp",
    });

    assert.ok(updated);
    assert.equal(updated.name, "After");
    assert.equal(updated.protocol, "acp");
    assert.equal(updated.url, "http://before:4000");
  });

  test("delete removes an unreferenced agent", async () => {
    const { agentService, agentRepo } = makeInfra();
    const agent = await agentService.register({
      name: "Disposable",
      url: "http://disposable:4000",
    });

    const deleted = await agentService.delete(agent.id);
    assert.equal(deleted, true);

    const found = await agentRepo.findById(agent.id);
    assert.equal(found, null);
  });

  test("delete rejects when channel bindings reference the agent", async () => {
    const { agentService, bindingService } = makeInfra();
    const agent = await agentService.register({
      name: "Referenced",
      url: "http://referenced:4000",
    });
    const binding = await bindingService.create({
      name: "References Agent",
      channelType: "feishu",
      accountId: "references-agent",
      channelConfig: { appId: "cli_ref", appSecret: "sec_ref" },
      agentId: agent.id,
      enabled: true,
    });

    await assert.rejects(
      agentService.delete(agent.id),
      (err: unknown) =>
        err instanceof ReferencedAgentError &&
        err.agentId === agent.id &&
        err.bindingIds.includes(binding.id),
    );
  });
});
