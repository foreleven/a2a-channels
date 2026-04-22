# RelayRuntime DI Runtime State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the gateway runtime so `RelayRuntime` is an injected local aggregate root, runtime bootstrap no longer blocks HTTP startup, and runtime APIs aggregate DB state with Redis or local-memory runtime state.

**Architecture:** The implementation is split into five vertical slices. First add DB-backed node registration and runtime-aware config, then extract injectable runtime collaborators and slim `RelayRuntime`, then introduce runtime state stores and query projections, then move startup behind a background bootstrapper, and finally move scheduling/reconcile logic behind an assignment coordinator so `RelayRuntime` stays local-only.

**Tech Stack:** TypeScript 6, Inversify, Hono, Prisma + SQLite, Node.js test runner, tsx, Redis-backed coordination interfaces

---

## File Structure

- Create: `apps/gateway/src/infra/runtime-node-repo.ts`
  DB-backed persistence for runtime node registration metadata.

- Create: `apps/gateway/src/runtime/runtime-node-state.ts`
  Local aggregate state shape for node lifecycle, owned bindings, and binding connection statuses.

- Create: `apps/gateway/src/runtime/node-runtime-state-store.ts`
  Runtime state store contracts plus runtime snapshot DTOs shared by runtime execution and query projection.

- Create: `apps/gateway/src/runtime/local-node-runtime-state-store.ts`
  Single-process runtime state store implementation used when cluster mode is disabled.

- Create: `apps/gateway/src/runtime/agent-client-registry.ts`
  Injectable lifecycle manager for agent client creation, reuse, start, and stop.

- Create: `apps/gateway/src/runtime/plugin-host-provider.ts`
  Injectable provider that constructs `OpenClawPluginRuntime`, `OpenClawPluginHost`, and registers plugins.

- Create: `apps/gateway/src/runtime/transport-registry-provider.ts`
  Injectable provider that assembles the transport registry from A2A and ACP transports.

- Create: `apps/gateway/src/runtime/runtime-cluster-state-reader.ts`
  Query service that merges DB records with Redis or local runtime state and produces API DTOs.

- Create: `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`
  Coordinator that reads desired state from DB and drives local runtime assignments.

- Create: `apps/gateway/src/runtime/runtime-bootstrapper.ts`
  Background startup/shutdown coordinator for runtime services.

- Create: `apps/gateway/src/container/modules/runtime.ts`
  Inversify module binding runtime services, providers, schedulers, and query services.

- Create: `apps/gateway/src/bootstrap/start-gateway.ts`
  Pure startup orchestrator that makes HTTP startup independent from runtime bootstrap.

- Modify: `apps/gateway/prisma/schema.prisma`
  Add `RuntimeNode` model for DB-backed node registration metadata.

- Modify: `apps/gateway/src/bootstrap/config.ts`
  Add runtime-related config fields such as `nodeId`, `nodeDisplayName`, `runtimeAddress`, `clusterMode`, and `redisUrl`.

- Modify: `apps/gateway/src/bootstrap/container.ts`
  Load the new runtime container module.

- Modify: `apps/gateway/src/container/modules/infra.ts`
  Bind `RuntimeNodeStateRepository` as an infra singleton.

- Modify: `apps/gateway/src/http/routes/runtime.ts`
  Replace the direct aggregate-shaped interface with a read-model interface that serves nodes and connections.

- Modify: `apps/gateway/src/http/app.ts`
  Pass `RuntimeClusterStateReader`-compatible options to runtime routes.

- Modify: `apps/gateway/src/index.ts`
  Stop manually constructing runtime pieces; delegate to `startGateway()`.

- Modify: `apps/gateway/src/runtime/bootstrap.ts`
  Select schedulers using injected collaborators instead of constructing `RelayRuntime`-coupled objects inline.

- Modify: `apps/gateway/src/runtime/local-scheduler.ts`
  Delegate reconcile work to `RuntimeAssignmentCoordinator`.

- Modify: `apps/gateway/src/runtime/cluster/leader-scheduler.ts`
  Hold leader-specific coordination wiring only; no direct runtime desired-state logic.

- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
  Remove `load()`, remove direct `new` construction of dependencies, shrink to local aggregate responsibilities, and publish snapshots through an injected store.

- Modify: `apps/gateway/src/container/container.test.ts`
  Cover config resolution, runtime bindings, and startup orchestration wiring.

- Modify: `apps/gateway/src/http/app.test.ts`
  Cover runtime node and connection routes through the query service interface.

- Modify: `apps/gateway/src/store/store.test.ts`
  Cover runtime node repo, local state store, `RelayRuntime`, assignment coordinator, and scheduler regressions.

## Task 1: Add DB-Backed Runtime Node Metadata

**Files:**
- Create: `apps/gateway/src/infra/runtime-node-repo.ts`
- Modify: `apps/gateway/prisma/schema.prisma`
- Modify: `apps/gateway/src/bootstrap/config.ts`
- Modify: `apps/gateway/src/container/modules/infra.ts`
- Modify: `apps/gateway/src/container/container.test.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [x] **Step 1: Write the failing tests for runtime node config and persistence**

```ts
// apps/gateway/src/container/container.test.ts
test("resolves runtime config fields", () => {
  const config = buildGatewayConfig({
    port: 7891,
    clusterMode: true,
    redisUrl: "redis://127.0.0.1:6379",
    nodeId: "node-a",
    nodeDisplayName: "Gateway Node A",
    runtimeAddress: "http://127.0.0.1:7891",
  });

  const container = buildGatewayContainer(config);
  const resolved = container.get<GatewayConfig>(GatewayConfigToken);

  assert.equal(resolved.clusterMode, true);
  assert.equal(resolved.redisUrl, "redis://127.0.0.1:6379");
  assert.equal(resolved.nodeId, "node-a");
  assert.equal(resolved.runtimeAddress, "http://127.0.0.1:7891");
});

// apps/gateway/src/store/store.test.ts
describe("RuntimeNodeStateRepository", () => {
  beforeEach(resetDB);

  test("upsert stores and updates runtime node metadata", async () => {
    const repo = new RuntimeNodeStateRepository();

    await repo.upsert({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "single",
      lastKnownAddress: "http://127.0.0.1:7891",
      registeredAt: "2026-04-21T08:00:00.000Z",
    });

    await repo.upsert({
      nodeId: "node-a",
      displayName: "Gateway Node A (renamed)",
      mode: "cluster",
      lastKnownAddress: "http://127.0.0.1:7892",
      registeredAt: "2026-04-21T08:00:00.000Z",
    });

    assert.deepEqual(await repo.list(), [{
      nodeId: "node-a",
      displayName: "Gateway Node A (renamed)",
      mode: "cluster",
      lastKnownAddress: "http://127.0.0.1:7892",
      registeredAt: "2026-04-21T08:00:00.000Z",
    }]);
  });
});
```

- [x] **Step 2: Run the targeted tests to confirm the gap**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts src/store/store.test.ts --test-name-pattern "runtime config fields|RuntimeNodeStateRepository"
```

Expected:

```text
not ok ... resolves runtime config fields
not ok ... RuntimeNodeStateRepository
error: Property 'clusterMode' does not exist on type 'GatewayConfig'
error: Cannot find module '../infra/runtime-node-repo.js'
```

- [x] **Step 3: Add the Prisma model, config fields, and runtime node repository**

```prisma
// apps/gateway/prisma/schema.prisma
model RuntimeNode {
  nodeId           String   @id @map("node_id")
  displayName      String   @map("display_name")
  mode             String
  lastKnownAddress String   @map("last_known_address")
  registeredAt     DateTime @map("registered_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  @@map("runtime_nodes")
}
```

```ts
// apps/gateway/src/bootstrap/config.ts
export interface GatewayConfig {
  port: number;
  corsOrigin: string;
  clusterMode: boolean;
  redisUrl?: string;
  nodeId: string;
  nodeDisplayName: string;
  runtimeAddress: string;
}

export function buildGatewayConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    port: overrides.port ?? Number(process.env["PORT"] ?? 7890),
    corsOrigin:
      overrides.corsOrigin ??
      process.env["CORS_ORIGIN"] ??
      "http://localhost:3000",
    clusterMode:
      overrides.clusterMode ?? process.env["CLUSTER_MODE"] === "true",
    redisUrl: overrides.redisUrl ?? process.env["REDIS_URL"] ?? undefined,
    nodeId:
      overrides.nodeId ??
      process.env["NODE_ID"] ??
      "node-local",
    nodeDisplayName:
      overrides.nodeDisplayName ??
      process.env["NODE_DISPLAY_NAME"] ??
      "Gateway Node Local",
    runtimeAddress:
      overrides.runtimeAddress ??
      process.env["RUNTIME_ADDRESS"] ??
      `http://localhost:${overrides.port ?? Number(process.env["PORT"] ?? 7890)}`,
  };
}
```

```ts
// apps/gateway/src/infra/runtime-node-repo.ts
import { injectable } from "inversify";
import { prisma } from "../store/prisma.js";

export interface RuntimeNodeRecord {
  nodeId: string;
  displayName: string;
  mode: "single" | "cluster";
  lastKnownAddress: string;
  registeredAt: string;
}

@injectable()
export class RuntimeNodeStateRepository {
  async upsert(record: RuntimeNodeRecord): Promise<RuntimeNodeRecord> {
    const saved = await prisma.runtimeNode.upsert({
      where: { nodeId: record.nodeId },
      create: {
        nodeId: record.nodeId,
        displayName: record.displayName,
        mode: record.mode,
        lastKnownAddress: record.lastKnownAddress,
        registeredAt: new Date(record.registeredAt),
      },
      update: {
        displayName: record.displayName,
        mode: record.mode,
        lastKnownAddress: record.lastKnownAddress,
      },
    });

    return {
      nodeId: saved.nodeId,
      displayName: saved.displayName,
      mode: saved.mode as "single" | "cluster",
      lastKnownAddress: saved.lastKnownAddress,
      registeredAt: saved.registeredAt.toISOString(),
    };
  }

  async list(): Promise<RuntimeNodeRecord[]> {
    const rows = await prisma.runtimeNode.findMany({
      orderBy: { registeredAt: "asc" },
    });

    return rows.map((row) => ({
      nodeId: row.nodeId,
      displayName: row.displayName,
      mode: row.mode as "single" | "cluster",
      lastKnownAddress: row.lastKnownAddress,
      registeredAt: row.registeredAt.toISOString(),
    }));
  }
}
```

```ts
// apps/gateway/src/container/modules/infra.ts
import { RuntimeNodeStateRepository } from "../../infra/runtime-node-repo.js";

bind(RuntimeNodeStateRepository).toSelf().inSingletonScope();
```

- [x] **Step 4: Sync Prisma and rerun the targeted tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && pnpm db:generate && pnpm db:push && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts src/store/store.test.ts --test-name-pattern "runtime config fields|RuntimeNodeStateRepository"
```

Expected:

```text
ok ... resolves runtime config fields
ok ... RuntimeNodeStateRepository upsert stores and updates runtime node metadata
```

- [x] **Step 5: Commit the runtime node metadata foundation**

```bash
cd /Users/feng/Projects/a2a-channels && git add apps/gateway/prisma/schema.prisma apps/gateway/src/bootstrap/config.ts apps/gateway/src/container/modules/infra.ts apps/gateway/src/container/container.test.ts apps/gateway/src/store/store.test.ts apps/gateway/src/infra/runtime-node-repo.ts && git commit -m "feat: add runtime node metadata foundation"
```

## Task 2: Extract Injectable Runtime Collaborators And Slim RelayRuntime

**Files:**
- Create: `apps/gateway/src/runtime/runtime-node-state.ts`
- Create: `apps/gateway/src/runtime/node-runtime-state-store.ts`
- Create: `apps/gateway/src/runtime/local-node-runtime-state-store.ts`
- Create: `apps/gateway/src/runtime/agent-client-registry.ts`
- Create: `apps/gateway/src/runtime/plugin-host-provider.ts`
- Create: `apps/gateway/src/runtime/transport-registry-provider.ts`
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [x] **Step 1: Write failing tests for injected runtime collaborators**

```ts
// apps/gateway/src/store/store.test.ts
describe("RelayRuntime aggregate", () => {
  test("publishes node lifecycle snapshots through an injected state store", async () => {
    const config = buildGatewayConfig({
      nodeId: "node-a",
      nodeDisplayName: "Gateway Node A",
      runtimeAddress: "http://127.0.0.1:7891",
    });
    const stateStore = new LocalNodeRuntimeStateStore();
    const pluginHostProvider = new PluginHostProvider();
    const transportRegistryProvider = new TransportRegistryProvider();
    const clientRegistry = new AgentClientRegistry(transportRegistryProvider);
    const runtime = new RelayRuntime(
      config,
      new RuntimeNodeState(config),
      stateStore,
      pluginHostProvider,
      clientRegistry,
    );

    await runtime.bootstrap();

    const [snapshot] = await stateStore.listNodeSnapshots();
    assert.equal(snapshot?.nodeId, "node-a");
    assert.equal(snapshot?.lifecycle, "ready");
  });
});
```

- [x] **Step 2: Run the targeted runtime tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "publishes node lifecycle snapshots"
```

Expected:

```text
not ok ... publishes node lifecycle snapshots through an injected state store
error: Cannot find module '../runtime/runtime-node-state.js'
```

- [x] **Step 3: Add runtime state, providers, registry, and inject them into RelayRuntime**

```ts
// apps/gateway/src/runtime/runtime-node-state.ts
import { injectable } from "inversify";
import type { RuntimeConnectionStatus } from "@a2a-channels/core";
import type { GatewayConfig } from "../bootstrap/config.js";

export interface LocalRuntimeSnapshot {
  nodeId: string;
  lifecycle: "created" | "bootstrapping" | "ready" | "stopping" | "stopped" | "error";
  schedulerRole: "local" | "leader" | "follower" | "unknown";
  ownedBindingIds: string[];
  bindingStatuses: RuntimeConnectionStatus[];
  lastError?: string;
  updatedAt: string;
}

@injectable()
export class RuntimeNodeState {
  private lifecycle: LocalRuntimeSnapshot["lifecycle"] = "created";
  private schedulerRole: LocalRuntimeSnapshot["schedulerRole"] = "unknown";
  private readonly statuses = new Map<string, RuntimeConnectionStatus>();
  private lastError: string | undefined;

  constructor(private readonly config: GatewayConfig) {}

  markBootstrapping() {
    this.lifecycle = "bootstrapping";
  }

  markReady(role: LocalRuntimeSnapshot["schedulerRole"]) {
    this.lifecycle = "ready";
    this.schedulerRole = role;
    this.lastError = undefined;
  }

  markError(error: unknown) {
    this.lifecycle = "error";
    this.lastError = String(error);
  }

  markStopping() {
    this.lifecycle = "stopping";
  }

  markStopped() {
    this.lifecycle = "stopped";
  }

  upsertBindingStatus(status: RuntimeConnectionStatus) {
    this.statuses.set(status.bindingId, status);
  }

  removeBinding(bindingId: string) {
    this.statuses.delete(bindingId);
  }

  snapshot(): LocalRuntimeSnapshot {
    return {
      nodeId: this.config.nodeId,
      lifecycle: this.lifecycle,
      schedulerRole: this.schedulerRole,
      ownedBindingIds: Array.from(this.statuses.keys()),
      bindingStatuses: Array.from(this.statuses.values()),
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }
}
```

```ts
// apps/gateway/src/runtime/node-runtime-state-store.ts
import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export const NodeRuntimeStateStoreToken = Symbol.for("runtime.NodeRuntimeStateStore");

export interface NodeRuntimeStateStore {
  publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void>;
  listNodeSnapshots(): Promise<LocalRuntimeSnapshot[]>;
}
```

```ts
// apps/gateway/src/runtime/local-node-runtime-state-store.ts
import { injectable } from "inversify";
import type { LocalRuntimeSnapshot, NodeRuntimeStateStore } from "./node-runtime-state-store.js";

@injectable()
export class LocalNodeRuntimeStateStore implements NodeRuntimeStateStore {
  private readonly nodes = new Map<string, LocalRuntimeSnapshot>();

  async publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void> {
    this.nodes.set(snapshot.nodeId, snapshot);
  }

  async listNodeSnapshots(): Promise<LocalRuntimeSnapshot[]> {
    return Array.from(this.nodes.values()).sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId),
    );
  }
}
```

```ts
// apps/gateway/src/runtime/transport-registry-provider.ts
import { injectable } from "inversify";
import { A2ATransport, ACPTransport } from "@a2a-channels/agent-transport";
import { TransportRegistry } from "@a2a-channels/core";

@injectable()
export class TransportRegistryProvider {
  readonly registry: TransportRegistry;

  constructor() {
    this.registry = new TransportRegistry();
    this.registry.register(new A2ATransport());
    this.registry.register(new ACPTransport());
  }
}
```

```ts
// apps/gateway/src/runtime/plugin-host-provider.ts
import { injectable } from "inversify";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";
import { registerAllPlugins } from "../register-plugins.js";

@injectable()
export class PluginHostProvider {
  readonly runtime: OpenClawPluginRuntime;
  readonly host: OpenClawPluginHost;

  constructor() {
    this.runtime = new OpenClawPluginRuntime({
      config: {
        loadConfig: () => ({ channels: [], services: [], providers: [] }),
        writeConfigFile: async () => {
          throw new Error("Not implemented");
        },
      },
    });
    this.host = new OpenClawPluginHost(this.runtime);
    registerAllPlugins(this.host);
  }
}
```

```ts
// apps/gateway/src/runtime/agent-client-registry.ts
import { inject, injectable } from "inversify";
import type { AgentClientHandle, AgentConfig } from "@a2a-channels/core";
import { TransportRegistryProvider } from "./transport-registry-provider.js";
import { createAgentClientHandle, startAgentClients, stopAgentClients } from "./agent-clients.js";

@injectable()
export class AgentClientRegistry {
  private readonly clients = new Map<string, AgentClientHandle>();

  constructor(
    @inject(TransportRegistryProvider)
    private readonly transports: TransportRegistryProvider,
  ) {}

  async upsert(agent: AgentConfig): Promise<AgentClientHandle> {
    const existing = this.clients.get(agent.url);
    if (existing) return existing;

    const client = createAgentClientHandle(
      agent,
      this.transports.registry.resolve(agent.protocol ?? "a2a"),
    );
    this.clients.set(agent.url, client);
    await startAgentClients([client]);
    return client;
  }

  async remove(agentUrl: string): Promise<void> {
    const client = this.clients.get(agentUrl);
    if (!client) return;
    this.clients.delete(agentUrl);
    await stopAgentClients([client]);
  }

  async shutdown(): Promise<void> {
    await stopAgentClients(this.clients.values());
    this.clients.clear();
  }
}
```

```ts
// apps/gateway/src/runtime/relay-runtime.ts
@injectable()
export class RelayRuntime {
  private readonly connectionManager: ConnectionManager;

  constructor(
    @inject(GatewayConfigToken) private readonly config: GatewayConfig,
    @inject(RuntimeNodeState) private readonly nodeState: RuntimeNodeState,
    @inject(NodeRuntimeStateStoreToken) private readonly stateStore: NodeRuntimeStateStore,
    @inject(PluginHostProvider) private readonly pluginHostProvider: PluginHostProvider,
    @inject(AgentClientRegistry) private readonly clientRegistry: AgentClientRegistry,
  ) {
    this.connectionManager = new ConnectionManager(
      this.pluginHostProvider.host,
      () => this.listEnabledBindings(),
      async (agentId) => this.getAgentClient(agentId),
      (event) => this.pluginHostProvider.runtime.emit("message:inbound", event),
      (event) => this.pluginHostProvider.runtime.emit("message:outbound", event),
    );
  }

  async bootstrap(): Promise<void> {
    this.nodeState.markBootstrapping();
    await this.publishSnapshot();
    this.nodeState.markReady("local");
    await this.publishSnapshot();
  }

  async shutdown(): Promise<void> {
    this.nodeState.markStopping();
    await this.publishSnapshot();
    await this.connectionManager.stopAllConnections();
    await this.clientRegistry.shutdown();
    this.nodeState.markStopped();
    await this.publishSnapshot();
  }

  snapshot(): LocalRuntimeSnapshot {
    return this.nodeState.snapshot();
  }

  private async publishSnapshot(): Promise<void> {
    await this.stateStore.publishNodeSnapshot(this.nodeState.snapshot());
  }
}
```

- [x] **Step 4: Rerun runtime container and aggregate tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "publishes node lifecycle snapshots"
```

Expected:

```text
ok ... publishes node lifecycle snapshots through an injected state store
```

- [x] **Step 5: Commit the runtime collaborator extraction**

```bash
cd /Users/feng/Projects/a2a-channels && git add apps/gateway/src/runtime/runtime-node-state.ts apps/gateway/src/runtime/node-runtime-state-store.ts apps/gateway/src/runtime/local-node-runtime-state-store.ts apps/gateway/src/runtime/agent-client-registry.ts apps/gateway/src/runtime/plugin-host-provider.ts apps/gateway/src/runtime/transport-registry-provider.ts apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/store/store.test.ts && git commit -m "refactor: inject relay runtime collaborators"
```

## Task 3: Add Runtime State Store And Query Projection

**Files:**
- Create: `apps/gateway/src/runtime/runtime-cluster-state-reader.ts`
- Modify: `apps/gateway/src/http/routes/runtime.ts`
- Modify: `apps/gateway/src/http/app.ts`
- Modify: `apps/gateway/src/runtime/node-runtime-state-store.ts`
- Modify: `apps/gateway/src/http/app.test.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [x] **Step 1: Write failing tests for runtime node and connection query routes**

```ts
// apps/gateway/src/http/app.test.ts
const runtimeReader = {
  listNodes: async () => [{
    nodeId: "node-a",
    displayName: "Gateway Node A",
    lifecycle: "bootstrapping",
    schedulerRole: "local",
    ownedBindingCount: 1,
    lastHeartbeatAt: "2026-04-21T08:00:00.000Z",
    lastError: null,
  }],
  listConnections: async () => [{
    bindingId: "binding-1",
    bindingName: "Binding",
    channelType: "feishu",
    accountId: "default",
    agentId: "agent-1",
    agentUrl: "http://localhost:3001",
    ownerNodeId: "node-a",
    status: "connected",
    updatedAt: "2026-04-21T08:00:00.000Z",
  }],
};

const app = buildHttpApp(container, {
  corsOrigin: "http://localhost:3000",
  runtime: runtimeReader,
  webDir: "/tmp/does-not-exist",
});

const nodesResponse = await app.request("/api/runtime/nodes");
assert.equal(nodesResponse.status, 200);
assert.deepEqual(await nodesResponse.json(), [{
  nodeId: "node-a",
  displayName: "Gateway Node A",
  lifecycle: "bootstrapping",
  schedulerRole: "local",
  ownedBindingCount: 1,
  lastHeartbeatAt: "2026-04-21T08:00:00.000Z",
  lastError: null,
}]);
```

```ts
// apps/gateway/src/store/store.test.ts
describe("RuntimeClusterStateReader", () => {
  beforeEach(resetDB);

  test("merges DB bindings with local runtime state", async () => {
    const stateStore = new LocalNodeRuntimeStateStore();
    const bindingRepo = new ChannelBindingStateRepository();
    const agentRepo = new AgentConfigStateRepository();
    const repo = new RuntimeNodeStateRepository();
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
    await repo.upsert({
      nodeId: "node-a",
      displayName: "Gateway Node A",
      mode: "single",
      lastKnownAddress: "http://127.0.0.1:7891",
      registeredAt: "2026-04-21T08:00:00.000Z",
    });
    await stateStore.publishNodeSnapshot({
      nodeId: "node-a",
      lifecycle: "ready",
      schedulerRole: "local",
      ownedBindingIds: [binding.id],
      bindingStatuses: [{
        bindingId: binding.id,
        status: "connected",
        agentUrl: "http://localhost:3001",
        updatedAt: "2026-04-21T08:00:00.000Z",
      }],
      updatedAt: "2026-04-21T08:00:00.000Z",
    });

    const reader = new RuntimeClusterStateReader(bindingRepo, agentRepo, repo, stateStore);
    const connections = await reader.listConnections();

    assert.equal(connections[0]?.ownerNodeId, "node-a");
    assert.equal(connections[0]?.bindingId, binding.id);
    assert.equal(connections[0]?.status, "connected");
  });
});
```

- [x] **Step 2: Run the route and projection tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/http/app.test.ts src/store/store.test.ts --test-name-pattern "runtime nodes|RuntimeClusterStateReader"
```

Expected:

```text
not ok ... /api/runtime/nodes
not ok ... RuntimeClusterStateReader merges DB bindings with local runtime state
error: app.request("/api/runtime/nodes") returned 404
error: Cannot find module '../runtime/runtime-cluster-state-reader.js'
```

- [x] **Step 3: Add the runtime state store and cluster state reader, then wire routes**

```ts
// apps/gateway/src/runtime/node-runtime-state-store.ts
import type { RuntimeConnectionStatus } from "@a2a-channels/core";
import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export interface RuntimeNodeListItem {
  nodeId: string;
  displayName: string;
  lifecycle: LocalRuntimeSnapshot["lifecycle"];
  schedulerRole: LocalRuntimeSnapshot["schedulerRole"];
  ownedBindingCount: number;
  lastHeartbeatAt: string;
  lastError: string | null;
}

export interface RuntimeConnectionListItem {
  bindingId: string;
  bindingName: string;
  channelType: string;
  accountId: string;
  agentId: string;
  agentUrl?: string;
  ownerNodeId: string | null;
  status: RuntimeConnectionStatus["status"] | "idle";
  updatedAt: string | null;
}

export interface NodeRuntimeStateStore {
  publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void>;
  listNodeSnapshots(): Promise<LocalRuntimeSnapshot[]>;
}
```

```ts
// apps/gateway/src/runtime/runtime-cluster-state-reader.ts
import { inject, injectable } from "inversify";
import { AgentConfigRepository, ChannelBindingRepository } from "@a2a-channels/domain";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { NodeRuntimeStateStoreToken, type NodeRuntimeStateStore, type RuntimeConnectionListItem, type RuntimeNodeListItem } from "./node-runtime-state-store.js";

@injectable()
export class RuntimeClusterStateReader {
  constructor(
    @inject(ChannelBindingRepository) private readonly bindings: ChannelBindingRepository,
    @inject(AgentConfigRepository) private readonly agents: AgentConfigRepository,
    @inject(RuntimeNodeStateRepository) private readonly runtimeNodes: RuntimeNodeStateRepository,
    @inject(NodeRuntimeStateStoreToken) private readonly stateStore: NodeRuntimeStateStore,
  ) {}

  async listNodes(): Promise<RuntimeNodeListItem[]> {
    const [records, snapshots] = await Promise.all([
      this.runtimeNodes.list(),
      this.stateStore.listNodeSnapshots(),
    ]);
    const snapshotsByNodeId = new Map(snapshots.map((item) => [item.nodeId, item]));
    return records.map((record) => {
      const snapshot = snapshotsByNodeId.get(record.nodeId);
      return {
        nodeId: record.nodeId,
        displayName: record.displayName,
        lifecycle: snapshot?.lifecycle ?? "created",
        schedulerRole: snapshot?.schedulerRole ?? "unknown",
        ownedBindingCount: snapshot?.ownedBindingIds.length ?? 0,
        lastHeartbeatAt: snapshot?.updatedAt ?? record.registeredAt,
        lastError: snapshot?.lastError ?? null,
      };
    });
  }

  async listConnections(): Promise<RuntimeConnectionListItem[]> {
    const [bindings, agents, snapshots] = await Promise.all([
      this.bindings.findAll(),
      this.agents.findAll(),
      this.stateStore.listNodeSnapshots(),
    ]);
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const ownerByBindingId = new Map<string, { nodeId: string; status: RuntimeConnectionListItem["status"]; updatedAt: string | null; agentUrl?: string }>();
    for (const snapshot of snapshots) {
      for (const status of snapshot.bindingStatuses) {
        ownerByBindingId.set(status.bindingId, {
          nodeId: snapshot.nodeId,
          status: status.status,
          updatedAt: status.updatedAt,
          agentUrl: status.agentUrl,
        });
      }
    }

    return bindings.map((binding) => {
      const owner = ownerByBindingId.get(binding.id);
      const agent = agentById.get(binding.agentId);
      return {
        bindingId: binding.id,
        bindingName: binding.name,
        channelType: binding.channelType,
        accountId: binding.accountId,
        agentId: binding.agentId,
        agentUrl: owner?.agentUrl ?? agent?.url,
        ownerNodeId: owner?.nodeId ?? null,
        status: owner?.status ?? "idle",
        updatedAt: owner?.updatedAt ?? null,
      };
    });
  }
}
```

```ts
// apps/gateway/src/http/routes/runtime.ts
export interface RuntimeStatusSource {
  listNodes(): Promise<RuntimeNodeListItem[]>;
  listConnections(): Promise<RuntimeConnectionListItem[]>;
}

export function registerRuntimeRoutes(app: Hono, runtime: RuntimeStatusSource): void {
  app.get("/api/runtime/nodes", async (c) => c.json(await runtime.listNodes()));
  app.get("/api/runtime/connections", async (c) =>
    c.json(await runtime.listConnections()),
  );
}
```

- [x] **Step 4: Rerun the route and projection tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/http/app.test.ts src/store/store.test.ts --test-name-pattern "runtime nodes|RuntimeClusterStateReader"
```

Expected:

```text
ok ... /api/runtime/nodes
ok ... RuntimeClusterStateReader merges DB bindings with local runtime state
```

- [x] **Step 5: Commit the runtime query projection layer**

```bash
cd /Users/feng/Projects/a2a-channels && git add apps/gateway/src/runtime/node-runtime-state-store.ts apps/gateway/src/runtime/runtime-cluster-state-reader.ts apps/gateway/src/http/routes/runtime.ts apps/gateway/src/http/app.ts apps/gateway/src/http/app.test.ts apps/gateway/src/store/store.test.ts && git commit -m "feat: add runtime state query projection"
```

## Task 4: Start HTTP Before Runtime Bootstrap

**Files:**
- Create: `apps/gateway/src/runtime/runtime-bootstrapper.ts`
- Create: `apps/gateway/src/container/modules/runtime.ts`
- Create: `apps/gateway/src/bootstrap/start-gateway.ts`
- Modify: `apps/gateway/src/bootstrap/container.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/container/container.test.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [x] **Step 1: Write failing tests for background runtime bootstrap**

```ts
// apps/gateway/src/container/container.test.ts
test("resolves runtime bootstrapper and runtime reader", () => {
  const container = buildGatewayContainer(buildGatewayConfig({ port: 7895 }));

  assert.ok(container.get(RuntimeBootstrapper));
  assert.ok(container.get(RuntimeClusterStateReader));
});

// apps/gateway/src/store/store.test.ts
describe("startGateway", () => {
  test("starts HTTP before runtime bootstrap resolves", async () => {
    const app = new Hono();
    app.get("/healthz", (c) => c.text("ok"));
    let bootstrapResolved = false;
    const bootstrapper = {
      bootstrap: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        bootstrapResolved = true;
      },
      shutdown: async () => {},
    };
    const outboxWorker = {
      start() {},
      async stop() {},
    } as OutboxWorker;

    const result = await startGateway({
      app,
      port: 7899,
      runtimeBootstrapper: bootstrapper,
      outboxWorker,
    });

    assert.equal(bootstrapResolved, false);
    await result.shutdown();
  });
});
```

- [x] **Step 2: Run the startup-focused tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts src/store/store.test.ts --test-name-pattern "runtime bootstrapper|starts HTTP before runtime bootstrap resolves"
```

Expected:

```text
not ok ... resolves runtime bootstrapper and runtime reader
not ok ... starts HTTP before runtime bootstrap resolves
error: No matching bindings found for serviceIdentifier: RuntimeBootstrapper
error: Cannot find module '../bootstrap/start-gateway.js'
```

- [x] **Step 3: Add the runtime module, bootstrapper, and startup orchestrator**

```ts
// apps/gateway/src/container/modules/runtime.ts
import { ContainerModule } from "inversify";
import { GatewayConfigToken } from "../../bootstrap/config.js";
import { LocalNodeRuntimeStateStore } from "../../runtime/local-node-runtime-state-store.js";
import { RuntimeBootstrapper } from "../../runtime/runtime-bootstrapper.js";
import { RuntimeClusterStateReader } from "../../runtime/runtime-cluster-state-reader.js";
import { RuntimeNodeState } from "../../runtime/runtime-node-state.js";
import { RelayRuntime } from "../../runtime/relay-runtime.js";
import { AgentClientRegistry } from "../../runtime/agent-client-registry.js";
import { PluginHostProvider } from "../../runtime/plugin-host-provider.js";
import { TransportRegistryProvider } from "../../runtime/transport-registry-provider.js";
import { NodeRuntimeStateStoreToken } from "../../runtime/node-runtime-state-store.js";

export function buildRuntimeModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(LocalNodeRuntimeStateStore).toSelf().inSingletonScope();
    bind(NodeRuntimeStateStoreToken).toService(LocalNodeRuntimeStateStore);
    bind(PluginHostProvider).toSelf().inSingletonScope();
    bind(TransportRegistryProvider).toSelf().inSingletonScope();
    bind(RuntimeNodeState).toDynamicValue((context) =>
      new RuntimeNodeState(context.get(GatewayConfigToken)),
    ).inSingletonScope();
    bind(AgentClientRegistry).toSelf().inSingletonScope();
    bind(RelayRuntime).toSelf().inSingletonScope();
    bind(RuntimeClusterStateReader).toSelf().inSingletonScope();
    bind(RuntimeBootstrapper).toSelf().inSingletonScope();
  });
}
```

```ts
// apps/gateway/src/runtime/runtime-bootstrapper.ts
import { inject, injectable } from "inversify";
import type { GatewayConfig } from "../bootstrap/config.js";
import { GatewayConfigToken } from "../bootstrap/config.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { RelayRuntime } from "./relay-runtime.js";
import { buildRuntimeBootstrap, type RuntimeBootstrap } from "./bootstrap.js";

@injectable()
export class RuntimeBootstrapper {
  private bootstrap: RuntimeBootstrap | null = null;

  constructor(
    @inject(GatewayConfigToken) private readonly config: GatewayConfig,
    @inject(RuntimeNodeStateRepository) private readonly nodes: RuntimeNodeStateRepository,
    @inject(RelayRuntime) private readonly runtime: RelayRuntime,
    @inject(DomainEventBus) private readonly eventBus: DomainEventBus,
  ) {}

  async bootstrap(): Promise<void> {
    await this.nodes.upsert({
      nodeId: this.config.nodeId,
      displayName: this.config.nodeDisplayName,
      mode: this.config.clusterMode ? "cluster" : "single",
      lastKnownAddress: this.config.runtimeAddress,
      registeredAt: new Date().toISOString(),
    });
    await this.runtime.bootstrap();
    this.bootstrap = buildRuntimeBootstrap({
      clusterMode: this.config.clusterMode,
      redisUrl: this.config.redisUrl,
      relay: this.runtime,
      eventBus: this.eventBus,
    });
    this.bootstrap.scheduler.start();
  }

  async shutdown(): Promise<void> {
    if (this.bootstrap) {
      await this.bootstrap.scheduler.stop();
    }
    await this.runtime.shutdown();
  }
}
```

```ts
// apps/gateway/src/bootstrap/start-gateway.ts
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { OutboxWorker } from "../infra/outbox-worker.js";
import type { RuntimeBootstrapper } from "../runtime/runtime-bootstrapper.js";

export async function startGateway(options: {
  app: Hono;
  port: number;
  outboxWorker: OutboxWorker;
  runtimeBootstrapper: Pick<RuntimeBootstrapper, "bootstrap" | "shutdown">;
}) {
  options.outboxWorker.start();

  const server = serve({ fetch: options.app.fetch, port: options.port });
  void options.runtimeBootstrapper.bootstrap().catch((error) => {
    console.error("[gateway] runtime bootstrap failed:", error);
  });

  return {
    server,
    async shutdown() {
      await options.runtimeBootstrapper.shutdown();
      await options.outboxWorker.stop();
      server.close();
    },
  };
}
```

```ts
// apps/gateway/src/bootstrap/container.ts
container.load(buildRuntimeModule());
```

```ts
// apps/gateway/src/index.ts
const container = buildGatewayContainer(gatewayConfig);
const runtimeBootstrapper = container.get(RuntimeBootstrapper);
const runtimeReader = container.get(RuntimeClusterStateReader);
const app = buildHttpApp(container, {
  corsOrigin: gatewayConfig.corsOrigin,
  runtime: runtimeReader,
  webDir: WEB_DIR,
});

await startGateway({
  app,
  port: gatewayConfig.port,
  outboxWorker: container.get(OutboxWorker),
  runtimeBootstrapper,
});
```

- [x] **Step 4: Rerun the startup-focused tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts src/store/store.test.ts --test-name-pattern "runtime bootstrapper|starts HTTP before runtime bootstrap resolves"
```

Expected:

```text
ok ... resolves runtime bootstrapper and runtime reader
ok ... starts HTTP before runtime bootstrap resolves
```

- [x] **Step 5: Commit the non-blocking startup refactor**

```bash
cd /Users/feng/Projects/a2a-channels && git add apps/gateway/src/runtime/runtime-bootstrapper.ts apps/gateway/src/container/modules/runtime.ts apps/gateway/src/bootstrap/start-gateway.ts apps/gateway/src/bootstrap/container.ts apps/gateway/src/index.ts apps/gateway/src/container/container.test.ts apps/gateway/src/store/store.test.ts && git commit -m "refactor: bootstrap runtime in background"
```

## Task 5: Move Reconcile Logic Into RuntimeAssignmentCoordinator

**Files:**
- Create: `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`
- Modify: `apps/gateway/src/container/modules/runtime.ts`
- Modify: `apps/gateway/src/runtime/local-scheduler.ts`
- Modify: `apps/gateway/src/runtime/cluster/leader-scheduler.ts`
- Modify: `apps/gateway/src/runtime/bootstrap.ts`
- Modify: `apps/gateway/src/runtime/runtime-bootstrapper.ts`
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Modify: `apps/gateway/src/store/store.test.ts`
- Modify: `apps/gateway/src/http/app.test.ts`

- [x] **Step 1: Write failing tests for coordinator-driven assignment**

```ts
// apps/gateway/src/store/store.test.ts
describe("RuntimeAssignmentCoordinator", () => {
  test("attaches runnable bindings for the local node and detaches disabled ones", async () => {
    const runtime = {
      applyAssignmentCalls: [] as string[],
      releaseAssignmentCalls: [] as string[],
      async applyAssignment(assignment: { bindingId: string }) {
        this.applyAssignmentCalls.push(assignment.bindingId);
      },
      async releaseAssignment(bindingId: string) {
        this.releaseAssignmentCalls.push(bindingId);
      },
      snapshot: () => ({
        nodeId: "node-a",
        lifecycle: "ready",
        schedulerRole: "local",
        ownedBindingIds: ["binding-disabled"],
        bindingStatuses: [],
        updatedAt: "2026-04-21T08:00:00.000Z",
      }),
    };

    const coordinator = new RuntimeAssignmentCoordinator(
      buildGatewayConfig({ nodeId: "node-a" }),
      runtime as RelayRuntime,
      async () => ({
        bindings: [{
          id: "binding-1",
          name: "Binding",
          channelType: "feishu",
          accountId: "default",
          channelConfig: { appId: "cli_1", appSecret: "sec_1" },
          agentId: "agent-1",
          enabled: true,
          createdAt: "2026-04-21T08:00:00.000Z",
        }],
        agents: [{
          id: "agent-1",
          name: "Echo",
          url: "http://localhost:3001",
          protocol: "a2a",
          createdAt: "2026-04-21T08:00:00.000Z",
        }],
      }),
    );

    await coordinator.reconcile();

    assert.deepEqual(runtime.applyAssignmentCalls, ["binding-1"]);
    assert.deepEqual(runtime.releaseAssignmentCalls, ["binding-disabled"]);
  });
});
```

```ts
// apps/gateway/src/http/app.test.ts
const runtimeResponse = await app.request("/api/runtime/connections");
assert.equal(runtimeResponse.status, 200);
assert.equal((await runtimeResponse.json())[0]?.ownerNodeId, "node-a");
```

- [x] **Step 2: Run the coordinator-focused tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts src/http/app.test.ts --test-name-pattern "RuntimeAssignmentCoordinator|ownerNodeId"
```

Expected:

```text
not ok ... RuntimeAssignmentCoordinator
error: Cannot find module '../runtime/runtime-assignment-coordinator.js'
```

- [x] **Step 3: Add the assignment coordinator and delegate schedulers to it**

```ts
// apps/gateway/src/runtime/runtime-assignment-coordinator.ts
import { inject, injectable } from "inversify";
import type { AgentConfig, ChannelBinding } from "@a2a-channels/core";
import type { GatewayConfig } from "../bootstrap/config.js";
import { GatewayConfigToken } from "../bootstrap/config.js";
import { RelayRuntime } from "./relay-runtime.js";
import { loadDesiredStateSnapshot } from "./state.js";

@injectable()
export class RuntimeAssignmentCoordinator {
  constructor(
    @inject(GatewayConfigToken) private readonly config: GatewayConfig,
    @inject(RelayRuntime) private readonly runtime: RelayRuntime,
    private readonly loadDesiredState: typeof loadDesiredStateSnapshot = loadDesiredStateSnapshot,
  ) {}

  async reconcile(): Promise<void> {
    const snapshot = await this.loadDesiredState();
    const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const desiredAssignments = new Map<string, { binding: ChannelBinding; agent: AgentConfig }>();

    for (const binding of snapshot.bindings) {
      const agent = agentsById.get(binding.agentId);
      if (!binding.enabled || !agent) {
        continue;
      }
      desiredAssignments.set(binding.id, { binding, agent });
    }

    for (const { binding, agent } of desiredAssignments.values()) {
      await this.runtime.applyAssignment({ binding, agent, ownerNodeId: this.config.nodeId });
    }

    for (const bindingId of this.runtime.snapshot().ownedBindingIds) {
      if (!desiredAssignments.has(bindingId)) {
        await this.runtime.releaseAssignment(bindingId);
      }
    }
  }
}
```

```ts
// apps/gateway/src/container/modules/runtime.ts
import { RuntimeAssignmentCoordinator } from "../../runtime/runtime-assignment-coordinator.js";

bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
```

```ts
// apps/gateway/src/runtime/bootstrap.ts
import type { DomainEventBus } from "../infra/domain-event-bus.js";
import { createRedisOwnershipGate } from "./cluster/redis-ownership-gate.js";
import { LeaderScheduler } from "./cluster/leader-scheduler.js";
import { LocalScheduler } from "./local-scheduler.js";
import type { OwnershipGate } from "./ownership-gate.js";
import type { RuntimeAssignmentCoordinator } from "./runtime-assignment-coordinator.js";

export interface RuntimeBootstrapOptions {
  clusterMode: boolean;
  redisUrl?: string;
  coordinator: RuntimeAssignmentCoordinator;
  eventBus: DomainEventBus;
  ownershipGate?: OwnershipGate;
}

export function buildRuntimeBootstrap(options: RuntimeBootstrapOptions): RuntimeBootstrap {
  if (options.clusterMode) {
    return {
      schedulerKind: "leader",
      scheduler: new LeaderScheduler(
        options.coordinator,
        options.ownershipGate ?? createRedisOwnershipGate(),
      ),
    };
  }

  return {
    schedulerKind: "local",
    scheduler: new LocalScheduler(options.coordinator, options.eventBus),
  };
}
```

```ts
// apps/gateway/src/runtime/runtime-bootstrapper.ts
import { RuntimeAssignmentCoordinator } from "./runtime-assignment-coordinator.js";

constructor(
  @inject(GatewayConfigToken) private readonly config: GatewayConfig,
  @inject(RuntimeNodeStateRepository) private readonly nodes: RuntimeNodeStateRepository,
  @inject(RelayRuntime) private readonly runtime: RelayRuntime,
  @inject(DomainEventBus) private readonly eventBus: DomainEventBus,
  @inject(RuntimeAssignmentCoordinator) private readonly coordinator: RuntimeAssignmentCoordinator,
) {}

this.bootstrap = buildRuntimeBootstrap({
  clusterMode: this.config.clusterMode,
  redisUrl: this.config.redisUrl,
  coordinator: this.coordinator,
  eventBus: this.eventBus,
});
```

```ts
// apps/gateway/src/runtime/local-scheduler.ts
export class LocalScheduler {
  constructor(
    private readonly coordinator: RuntimeAssignmentCoordinator,
    private readonly eventBus: DomainEventBus,
    private readonly options: LocalSchedulerOptions = {},
  ) {}

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.coordinator.reconcile();
    } finally {
      this.reconciling = false;
    }
  }
}
```

```ts
// apps/gateway/src/runtime/cluster/leader-scheduler.ts
export class LeaderScheduler {
  constructor(
    private readonly coordinator: RuntimeAssignmentCoordinator,
    private readonly ownershipGate: OwnershipGate,
  ) {}

  start(): void {
    void this.ownershipGate;
    void this.coordinator.reconcile();
  }

  async stop(): Promise<void> {}
}
```

```ts
// apps/gateway/src/runtime/relay-runtime.ts
async applyAssignment(assignment: {
  binding: ChannelBinding;
  agent: AgentConfig;
  ownerNodeId: string;
}): Promise<void> {
  await this.clientRegistry.upsert(assignment.agent);
  await this.applyBindingUpsert(assignment.binding);
  await this.publishSnapshot();
}

async releaseAssignment(bindingId: string): Promise<void> {
  await this.applyBindingDelete(bindingId);
  await this.publishSnapshot();
}
```

- [x] **Step 4: Run the full gateway regression suite and typecheck**

Run:

```bash
cd /Users/feng/Projects/a2a-channels && pnpm typecheck && pnpm test
```

Expected:

```text
Found 0 errors.
...
# tests
...
# pass
```

- [x] **Step 5: Commit the coordinator-driven scheduling refactor**

```bash
cd /Users/feng/Projects/a2a-channels && git add apps/gateway/src/container/modules/runtime.ts apps/gateway/src/runtime/runtime-assignment-coordinator.ts apps/gateway/src/runtime/local-scheduler.ts apps/gateway/src/runtime/cluster/leader-scheduler.ts apps/gateway/src/runtime/bootstrap.ts apps/gateway/src/runtime/runtime-bootstrapper.ts apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/store/store.test.ts apps/gateway/src/http/app.test.ts && git commit -m "refactor: move runtime reconcile into coordinator"
```

## Self-Review Checklist

- [x] Confirm every requirement from `docs/superpowers/specs/2026-04-21-relay-runtime-di-design.md` maps to at least one task above.
- [x] Search this file for `TBD`, `TODO`, `maybe`, `optional`, `later`, and remove any placeholder wording before implementation starts.
- [x] Verify type names stay consistent across tasks:
  - `RuntimeNodeStateRepository`
  - `LocalRuntimeSnapshot`
  - `NodeRuntimeStateStore`
  - `RuntimeClusterStateReader`
  - `RuntimeBootstrapper`
  - `RuntimeAssignmentCoordinator`
- [x] Verify every command uses the current repo scripts or direct Node test invocation patterns from `AGENTS.md`.
