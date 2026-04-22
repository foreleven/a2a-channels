# Runtime Ownership Domain Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor gateway runtime ownership so `RuntimeOwnershipState` becomes the single local domain model for assigned bindings, `ConnectionManager` no longer depends on global binding lists, and `RelayRuntime` shrinks into a thin orchestration shell.

**Architecture:** The refactor keeps scheduler and coordinator behavior unchanged. `LocalScheduler` and `LeaderScheduler` continue consuming `ChannelBindingEvent` and triggering reconcile. The local runtime changes happen behind that boundary: `RuntimeOwnershipState` stores owned bindings plus reconnect state, `ConnectionManager` handles one binding at a time, `RuntimeNodeState` becomes a node-lifecycle projection builder, and `RelayRuntime` delegates state transitions instead of owning them.

**Tech Stack:** TypeScript, Node.js test runner, Inversify, OpenClaw compatibility runtime, Prisma/SQLite test harness

---

## File Structure

- Modify: `apps/gateway/src/runtime/ownership-state.ts`
  Expand ownership state from a status map into the rich local binding ownership model.

- Modify: `apps/gateway/src/runtime/reconnect-policy.ts`
  Keep reconnect policy pure, but make sure the API remains the single source for reconnect delay decisions used by ownership state.

- Modify: `apps/gateway/src/runtime/runtime-node-state.ts`
  Remove mutable binding-status ownership and convert it into a lifecycle snapshot builder fed by ownership state.

- Modify: `apps/gateway/src/connection-manager.ts`
  Remove `listBindings` and `syncConnections()`. Keep only per-binding lifecycle and reply dispatch behavior.

- Modify: `apps/gateway/src/runtime/connection-manager-provider.ts`
  Update constructor/provider wiring after removing `listBindings`.

- Modify: `apps/gateway/src/runtime/relay-runtime-assembly-provider.ts`
  Stop passing binding-list functions into the connection manager assembly.

- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
  Remove duplicated ownership maps and reconnect timer state; delegate to `RuntimeOwnershipState`.

- Modify: `apps/gateway/src/store/store.test.ts`
  Add/adjust regression tests for ownership behavior, relay runtime behavior, reconnect scheduling, and provider wiring.

## Task 1: Expand `RuntimeOwnershipState` Into The Local Binding Domain

**Files:**
- Modify: `apps/gateway/src/runtime/ownership-state.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write failing ownership-state tests**

Add a focused test block near the existing runtime tests in `apps/gateway/src/store/store.test.ts`:

```ts
describe("RuntimeOwnershipState", () => {
  const createBinding = (
    overrides: Partial<{
      enabled: boolean;
      channelConfig: Record<string, unknown>;
    }> = {},
  ) => ({
    id: "binding-1",
    name: "Binding One",
    channelType: "feishu",
    accountId: "default",
    channelConfig: { appId: "cli_1", appSecret: "sec_1", ...overrides.channelConfig },
    agentId: "agent-1",
    enabled: overrides.enabled ?? true,
    createdAt: "2026-04-22T00:00:00.000Z",
  });

  test("upsertBinding stores the binding record and requests a start for a runnable new binding", () => {
    const state = createRuntimeOwnershipState();

    const decision = state.upsertBinding(createBinding(), {
      forceRestart: false,
      hasActiveConnection: false,
      runnable: true,
    });

    assert.deepEqual(decision, {
      publishSnapshot: true,
      shouldRestart: true,
      shouldStop: false,
    });
    assert.equal(state.getOwnedBinding("binding-1")?.binding.agentId, "agent-1");
    assert.equal(state.listConnectionStatuses()[0]?.status, "idle");
  });

  test("upsertBinding keeps an unchanged healthy binding in place without restarting", () => {
    const state = createRuntimeOwnershipState();
    const binding = createBinding();

    state.upsertBinding(binding, {
      forceRestart: false,
      hasActiveConnection: false,
      runnable: true,
    });
    state.markConnected(binding.id, "http://agent-1");

    const decision = state.upsertBinding(binding, {
      forceRestart: false,
      hasActiveConnection: true,
      runnable: true,
    });

    assert.deepEqual(decision, {
      publishSnapshot: false,
      shouldRestart: false,
      shouldStop: false,
    });
  });

  test("releaseBinding clears the owned record and any scheduled reconnect", async () => {
    const state = createRuntimeOwnershipState({
      reconnectPolicy: createReconnectPolicy({ baseDelayMs: 1, maxDelayMs: 1 }),
    });
    const binding = createBinding();

    state.upsertBinding(binding, {
      forceRestart: false,
      hasActiveConnection: false,
      runnable: true,
    });

    state.scheduleReconnect(binding.id, 1, () => {
      throw new Error("released bindings must not reconnect");
    });
    state.releaseBinding(binding.id);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.getOwnedBinding(binding.id), undefined);
    assert.deepEqual(state.listConnectionStatuses(), []);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RuntimeOwnershipState"
```

Expected:

```text
not ok ... RuntimeOwnershipState
error: state.upsertBinding is not a function
```

- [ ] **Step 3: Implement the richer ownership model**

Update `apps/gateway/src/runtime/ownership-state.ts` so it stores binding facts and reconnect timers:

```ts
interface OwnedRuntimeBinding {
  binding: ChannelBinding;
  status: RuntimeConnectionStatus;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface BindingOwnershipDecision {
  publishSnapshot: boolean;
  shouldRestart: boolean;
  shouldStop: boolean;
}

export interface RuntimeOwnershipState {
  upsertBinding(
    binding: ChannelBinding,
    options: {
      forceRestart: boolean;
      hasActiveConnection: boolean;
      runnable: boolean;
    },
  ): BindingOwnershipDecision;
  releaseBinding(bindingId: string): boolean;
  getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined;
  listOwnedBindings(): ChannelBinding[];
  listConnectionStatuses(): RuntimeConnectionStatus[];
  scheduleReconnect(bindingId: string, delayMs: number, callback: () => void): void;
  clearReconnect(bindingId: string): void;
  markIdle(bindingId: string): RuntimeConnectionStatus;
  markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision;
  markError(bindingId: string, error: unknown, agentUrl?: string): ReconnectDecision;
}

function bindingsEquivalent(left: ChannelBinding, right: ChannelBinding): boolean {
  return (
    left.name === right.name &&
    left.channelType === right.channelType &&
    left.accountId === right.accountId &&
    left.agentId === right.agentId &&
    left.enabled === right.enabled &&
    JSON.stringify(left.channelConfig) === JSON.stringify(right.channelConfig)
  );
}

export function createRuntimeOwnershipState(
  options: CreateRuntimeOwnershipStateOptions = {},
): RuntimeOwnershipState {
  const bindings = new Map<string, OwnedRuntimeBinding>();
  const reconnectPolicy = options.reconnectPolicy ?? createReconnectPolicy();

  return {
    upsertBinding(binding, decisionInput) {
      const existing = bindings.get(binding.id);

      if (!existing) {
        bindings.set(binding.id, {
          binding,
          status: {
            bindingId: binding.id,
            status: "idle",
            updatedAt: new Date().toISOString(),
          },
          reconnectAttempt: 0,
          reconnectTimer: null,
        });

        return {
          publishSnapshot: true,
          shouldRestart: decisionInput.runnable && binding.enabled,
          shouldStop: !decisionInput.runnable || !binding.enabled,
        };
      }

      const equivalent = bindingsEquivalent(existing.binding, binding);
      existing.binding = binding;

      if (!binding.enabled || !decisionInput.runnable) {
        this.clearReconnect(binding.id);
        existing.reconnectAttempt = 0;
        existing.status = {
          bindingId: binding.id,
          status: "idle",
          updatedAt: new Date().toISOString(),
        };
        return {
          publishSnapshot: true,
          shouldRestart: false,
          shouldStop: true,
        };
      }

      if (equivalent && decisionInput.hasActiveConnection && !decisionInput.forceRestart) {
        return {
          publishSnapshot: false,
          shouldRestart: false,
          shouldStop: false,
        };
      }

      this.clearReconnect(binding.id);
      existing.status = {
        bindingId: binding.id,
        status: "idle",
        updatedAt: new Date().toISOString(),
      };
      return {
        publishSnapshot: true,
        shouldRestart: true,
        shouldStop: false,
      };
    },
```

- [ ] **Step 4: Finish timer ownership and record accessors**

Complete the ownership-state implementation with reconnect scheduling and accessors:

```ts
    releaseBinding(bindingId) {
      const existing = bindings.get(bindingId);
      if (!existing) {
        return false;
      }

      this.clearReconnect(bindingId);
      bindings.delete(bindingId);
      return true;
    },

    getOwnedBinding(bindingId) {
      return bindings.get(bindingId);
    },

    listOwnedBindings() {
      return Array.from(bindings.values(), (entry) => entry.binding).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
    },

    listConnectionStatuses() {
      return Array.from(bindings.values(), (entry) => ({ ...entry.status })).sort(
        (left, right) => left.bindingId.localeCompare(right.bindingId),
      );
    },

    scheduleReconnect(bindingId, delayMs, callback) {
      const existing = bindings.get(bindingId);
      if (!existing) {
        return;
      }

      this.clearReconnect(bindingId);
      existing.reconnectTimer = setTimeout(() => {
        existing.reconnectTimer = null;
        callback();
      }, delayMs);
    },

    clearReconnect(bindingId) {
      const existing = bindings.get(bindingId);
      if (!existing || !existing.reconnectTimer) {
        return;
      }

      clearTimeout(existing.reconnectTimer);
      existing.reconnectTimer = null;
    },

    markIdle(bindingId) {
      const existing = bindings.get(bindingId);
      if (!existing) {
        throw new Error(`Binding ${bindingId} not found`);
      }

      existing.status = {
        bindingId,
        status: "idle",
        updatedAt: new Date().toISOString(),
      };
      return { ...existing.status };
    },
```

- [ ] **Step 5: Re-run the focused tests and verify they pass**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RuntimeOwnershipState"
```

Expected:

```text
# tests 3
# pass 3
```

- [ ] **Step 6: Commit the ownership-state change**

Run:

```bash
git add apps/gateway/src/runtime/ownership-state.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: enrich runtime ownership state"
```

## Task 2: Remove Global Binding Reconciliation From `ConnectionManager`

**Files:**
- Modify: `apps/gateway/src/connection-manager.ts`
- Modify: `apps/gateway/src/runtime/connection-manager-provider.ts`
- Modify: `apps/gateway/src/runtime/relay-runtime-assembly-provider.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Add a failing regression test for the provider contract**

Add this test near the other runtime assembly tests:

```ts
test("RelayRuntimeAssemblyProvider builds a connection manager without listBindings", () => {
  const provider = new RelayRuntimeAssemblyProvider(
    new PluginHostProvider(),
    new ConnectionManagerProvider(),
  );

  const assembly = provider.create({
    loadConfig: () => ({ channels: { feishu: { accounts: {} } } }) as never,
    getAgentClient: async () => ({
      client: { send: async () => ({ text: "ok" }) },
      url: "http://agent-1",
    }),
  });

  assert.ok(assembly.connectionManager);
});
```

- [ ] **Step 2: Run the focused test and verify it fails on the old signature**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "connection manager without listBindings"
```

Expected:

```text
error TS2345: Property 'listBindings' is missing
```

- [ ] **Step 3: Remove `listBindings` and `syncConnections()` from the manager**

Apply this shape to `apps/gateway/src/connection-manager.ts`:

```ts
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly host: OpenClawPluginHost,
    private readonly getAgentClient: (
      agentId: string,
    ) =>
      | { client: AgentClientHandle; url: string }
      | Promise<{ client: AgentClientHandle; url: string }>,
    private readonly emitMessageInbound?: (event: MessageInboundEvent) => void,
    private readonly emitMessageOutbound?: (
      event: MessageOutboundEvent,
    ) => void,
    private readonly callbacks: ConnectionManagerCallbacks = {},
  ) {}

  async restartConnection(binding: ChannelBinding): Promise<void> {
    const existing = this.connections.get(binding.id);
    if (existing) {
      existing.suppressDisconnectStatus = true;
      existing.abortController.abort();
      await existing.promise.catch(() => {});
      this.connections.delete(binding.id);
    }

    const connection = await this.createConnection(binding);
    this.connections.set(binding.id, connection);
  }
}
```

Delete the dead method entirely:

```ts
// remove from apps/gateway/src/connection-manager.ts
async syncConnections(): Promise<void> { ... }
```

- [ ] **Step 4: Update provider and assembly wiring**

Change the provider signature:

```ts
export interface ConnectionManagerProviderOptions {
  host: OpenClawPluginHost;
  getAgentClient: (
    agentId: string,
  ) => { client: AgentClientHandle; url: string } | Promise<{
    client: AgentClientHandle;
    url: string;
  }>;
  emitMessageInbound?: (event: MessageInboundEvent) => void;
  emitMessageOutbound?: (event: MessageOutboundEvent) => void;
  callbacks?: ConnectionManagerCallbacks;
}

export class ConnectionManagerProvider {
  create(options: ConnectionManagerProviderOptions): ConnectionManager {
    return new ConnectionManager(
      options.host,
      options.getAgentClient,
      options.emitMessageInbound,
      options.emitMessageOutbound,
      options.callbacks ?? {},
    );
  }
}
```

Then simplify the assembly contract:

```ts
export interface RelayRuntimeAssemblyOptions {
  loadConfig: () => OpenClawConfig;
  getAgentClient: (
    agentId: string,
  ) => { client: AgentClientHandle; url: string } | Promise<{
    client: AgentClientHandle;
    url: string;
  }>;
  callbacks?: ConnectionManagerCallbacks;
}

connectionManager = this.connectionManagerProvider.create({
  host: pluginHost,
  getAgentClient: options.getAgentClient,
  emitMessageInbound: (event) => runtime.emit("message:inbound", event),
  emitMessageOutbound: (event) => runtime.emit("message:outbound", event),
  callbacks: options.callbacks,
});
```

- [ ] **Step 5: Re-run the connection-manager-focused tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "connection manager without listBindings|binding lifecycle callbacks|agent send failures"
```

Expected:

```text
# pass 3
```

- [ ] **Step 6: Commit the connection-manager boundary cleanup**

Run:

```bash
git add apps/gateway/src/connection-manager.ts apps/gateway/src/runtime/connection-manager-provider.ts apps/gateway/src/runtime/relay-runtime-assembly-provider.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: remove global binding dependency from connection manager"
```

## Task 3: Turn `RuntimeNodeState` Into A Pure Node Snapshot Builder

**Files:**
- Modify: `apps/gateway/src/runtime/runtime-node-state.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Add a failing projection test**

Add this test near the runtime snapshot tests:

```ts
test("RuntimeNodeState snapshots use externally supplied binding statuses", () => {
  const config = buildGatewayConfig({
    clusterMode: false,
    nodeId: "node-a",
    nodeDisplayName: "Node A",
    runtimeAddress: "http://127.0.0.1:7890",
  });
  const state = new RuntimeNodeState(config);

  state.markBootstrapping();
  const snapshot = state.snapshot([
    {
      bindingId: "binding-1",
      status: "connected",
      agentUrl: "http://agent-1",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
  ]);

  assert.equal(snapshot.bindingStatuses[0]?.status, "connected");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "externally supplied binding statuses"
```

Expected:

```text
error TS2554: Expected 0 arguments, but got 1
```

- [ ] **Step 3: Remove mutable binding-status storage from `RuntimeNodeState`**

Refactor `apps/gateway/src/runtime/runtime-node-state.ts` around this API:

```ts
export class RuntimeNodeState {
  private lifecycle: LocalRuntimeLifecycle = "stopped";
  private lastError: string | null = null;
  private lastHeartbeatAt: string | null = null;

  constructor(private readonly config: GatewayConfig) {}

  markBootstrapping(): LocalRuntimeSnapshot {
    return this.updateLifecycle("bootstrapping", null, true, []);
  }

  markReady(bindingStatuses: RuntimeConnectionStatus[] = []): LocalRuntimeSnapshot {
    return this.updateLifecycle("ready", null, true, bindingStatuses);
  }

  markStopping(bindingStatuses: RuntimeConnectionStatus[] = []): LocalRuntimeSnapshot {
    return this.updateLifecycle("stopping", null, false, bindingStatuses);
  }

  markStopped(): LocalRuntimeSnapshot {
    return this.updateLifecycle("stopped", null, false, []);
  }

  snapshot(bindingStatuses: RuntimeConnectionStatus[] = []): LocalRuntimeSnapshot {
    return {
      nodeId: this.config.nodeId,
      displayName: this.config.nodeDisplayName,
      mode: this.config.clusterMode ? "cluster" : "local",
      schedulerRole: this.config.clusterMode ? "unknown" : "local",
      lastKnownAddress: this.config.runtimeAddress,
      lifecycle: this.lifecycle,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      bindingStatuses: bindingStatuses.map((status) => ({ ...status })).sort(
        (left, right) => left.bindingId.localeCompare(right.bindingId),
      ),
      updatedAt: new Date().toISOString(),
    };
  }
```

- [ ] **Step 4: Remove the old binding-specific mutators**

Delete these methods from `apps/gateway/src/runtime/runtime-node-state.ts`:

```ts
attachBinding(...)
detachBinding(...)
markBindingIdle(...)
markBindingConnecting(...)
markBindingConnected(...)
markBindingDisconnected(...)
markBindingError(...)
```

Use `snapshot(bindingStatuses)` instead of mutating binding state inside this class.

- [ ] **Step 5: Re-run the projection test**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "externally supplied binding statuses"
```

Expected:

```text
# pass 1
```

- [ ] **Step 6: Commit the node-state projection cleanup**

Run:

```bash
git add apps/gateway/src/runtime/runtime-node-state.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: project runtime binding statuses from ownership state"
```

## Task 4: Shrink `RelayRuntime` To A Thin Orchestration Shell

**Files:**
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Add failing integration tests for the new ownership boundary**

Update the existing `RelayRuntime` tests in `apps/gateway/src/store/store.test.ts` to assert ownership, not internal maps:

```ts
test("assignBinding stores the owned binding inside ownership state and releaseBinding removes it", async () => {
  const runtime = createRelayRuntimeForTest();
  const binding = createBinding();
  const agent = createAgent();

  await runtime.assignBinding(binding, agent);
  assert.equal(runtime.ownershipState.getOwnedBinding(binding.id)?.binding.id, binding.id);

  await runtime.releaseBinding(binding.id);
  assert.equal(runtime.ownershipState.getOwnedBinding(binding.id), undefined);
});

test("connection error schedules reconnect through ownership state for the current owned binding", async () => {
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
  runtime.applyOwnedConnectionStatus(binding.id, "error", agent.url, new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(restartCalls, ["binding-1", "binding-1"]);
  assert.equal(runtime.ownershipState.getOwnedBinding(binding.id)?.status.status, "error");
});
```

- [ ] **Step 2: Run the runtime-focused tests and verify they fail**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "owned binding inside ownership state|schedules reconnect through ownership state|refreshing a binding into a non-runnable state"
```

Expected:

```text
not ok ... owned binding inside ownership state
```

- [ ] **Step 3: Remove duplicate binding maps and rebuild config from ownership state**

Refactor the top of `apps/gateway/src/runtime/relay-runtime.ts`:

```ts
export class RelayRuntime {
  readonly name = "local";
  readonly transportRegistry: TransportRegistry;
  readonly runtime: OpenClawPluginRuntime;
  readonly pluginHost: OpenClawPluginHost;
  readonly connectionManager: RelayRuntimeAssembly["connectionManager"];

  private agentsById = new Map<string, AgentConfig>();
  private agentsByUrl = new Map<string, AgentConfig>();
  private readonly nodeState: RuntimeNodeState;
  private readonly stateStore: NodeRuntimeStateStore;
  private readonly agentClientRegistry: AgentClientRegistry;
  private readonly ownershipState: RuntimeOwnershipState;
  private openClawConfig: OpenClawConfig;
  private nodeSnapshotPublishQueue: Promise<void> = Promise.resolve();

  constructor(...) {
    ...
    this.openClawConfig = buildOpenClawConfigFromBindings([], this.agentsById);
    const assembly = assemblyProvider.create({
      loadConfig: () => this.openClawConfig,
      getAgentClient: (agentId) => this.getAgentClient(agentId),
      callbacks: {
        onConnectionStatus: ({ binding, status, agentUrl, error }) => {
          this.applyOwnedConnectionStatus(binding.id, status, agentUrl, error);
        },
      },
    });
  }

  listBindings(): ChannelBinding[] {
    return this.ownershipState.listOwnedBindings();
  }
```

Delete:

```ts
private bindingsById = new Map<string, ChannelBinding>();
private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

- [ ] **Step 4: Push assignment decisions down into ownership state**

Replace `applyBindingUpsert()` and `applyBindingDelete()` with delegation to ownership state:

```ts
async applyBindingUpsert(
  binding: ChannelBinding,
  options: ApplyBindingUpsertOptions = {},
): Promise<void> {
  const decision = this.ownershipState.upsertBinding(binding, {
    forceRestart: options.forceRestart ?? false,
    hasActiveConnection: this.hasActiveConnection(binding.id),
    runnable: this.isRunnableBinding(binding),
  });

  this.openClawConfig = buildOpenClawConfigFromBindings(
    this.ownershipState.listOwnedBindings(),
    this.agentsById,
  );

  if (decision.publishSnapshot) {
    await this.publishOwnershipSnapshot();
  }

  if (decision.shouldStop) {
    await this.connectionManager.stopConnection(binding.id);
    return;
  }

  if (decision.shouldRestart) {
    await this.connectionManager.restartConnection(binding);
  }
}

async applyBindingDelete(bindingId: string): Promise<void> {
  if (!this.ownershipState.releaseBinding(bindingId)) {
    return;
  }

  this.openClawConfig = buildOpenClawConfigFromBindings(
    this.ownershipState.listOwnedBindings(),
    this.agentsById,
  );
  await this.publishOwnershipSnapshot();
  await this.connectionManager.stopConnection(bindingId);
}
```

- [ ] **Step 5: Move reconnect timer ownership out of `RelayRuntime`**

Replace the old timer helpers in `apps/gateway/src/runtime/relay-runtime.ts`:

```ts
private async publishOwnershipSnapshot(): Promise<void> {
  await this.publishNodeSnapshot(
    this.nodeState.snapshot(this.ownershipState.listConnectionStatuses()),
  );
}

private scheduleReconnect(bindingId: string, delayMs: number): void {
  this.ownershipState.scheduleReconnect(bindingId, delayMs, () => {
    const owned = this.ownershipState.getOwnedBinding(bindingId);
    if (!owned || !owned.binding.enabled || !this.isRunnableBinding(owned.binding)) {
      return;
    }

    void this.connectionManager.restartConnection(owned.binding);
  });
}

private clearReconnectTimer(bindingId: string): void {
  this.ownershipState.clearReconnect(bindingId);
}
```

Then update `applyOwnedConnectionStatus()`:

```ts
private applyOwnedConnectionStatus(
  bindingId: string,
  status: RuntimeConnectionStatus["status"],
  agentUrl?: string,
  error?: unknown,
): void {
  const owned = this.ownershipState.getOwnedBinding(bindingId);
  if (!owned) {
    return;
  }

  switch (status) {
    case "connecting":
      this.ownershipState.clearReconnect(bindingId);
      this.ownershipState.markConnecting(bindingId, agentUrl);
      break;
    case "connected":
      this.ownershipState.clearReconnect(bindingId);
      this.ownershipState.markConnected(bindingId, agentUrl);
      break;
    case "disconnected": {
      const decision = this.ownershipState.markDisconnected(bindingId, agentUrl);
      this.scheduleReconnect(bindingId, decision.delayMs);
      break;
    }
    case "error": {
      const decision = this.ownershipState.markError(
        bindingId,
        error ?? new Error("Unknown connection error"),
        agentUrl,
      );
      this.scheduleReconnect(bindingId, decision.delayMs);
      break;
    }
    case "idle":
      this.ownershipState.markIdle(bindingId);
      break;
  }

  this.publishNodeSnapshotInBackground(
    this.nodeState.snapshot(this.ownershipState.listConnectionStatuses()),
  );
}
```

- [ ] **Step 6: Re-run the runtime regression tests**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RelayRuntime|RuntimeOwnershipState"
```

Expected:

```text
# all RelayRuntime and RuntimeOwnershipState tests pass
```

- [ ] **Step 7: Commit the runtime shell refactor**

Run:

```bash
git add apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: move runtime binding state into ownership domain"
```

## Task 5: Full Verification Before Completion

**Files:**
- Modify: `apps/gateway/src/store/store.test.ts` if any follow-up assertion fixes are needed

- [ ] **Step 1: Run the full checked-in gateway test suite**

Run:

```bash
cd /Users/feng/Projects/a2a-channels && pnpm test
```

Expected:

```text
All tests passed
```

- [ ] **Step 2: Run the TypeScript typecheck for the non-web workspace**

Run:

```bash
cd /Users/feng/Projects/a2a-channels && pnpm typecheck
```

Expected:

```text
Found 0 errors
```

- [ ] **Step 3: Run a focused regression sweep for runtime assignment and scheduling**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "LocalScheduler|RuntimeAssignmentCoordinator|RelayRuntime|RuntimeOwnershipState"
```

Expected:

```text
# all focused runtime tests pass
```

- [ ] **Step 4: Commit any final assertion or typing fixes**

Run:

```bash
git add apps/gateway/src/runtime/ownership-state.ts apps/gateway/src/runtime/runtime-node-state.ts apps/gateway/src/connection-manager.ts apps/gateway/src/runtime/connection-manager-provider.ts apps/gateway/src/runtime/relay-runtime-assembly-provider.ts apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/store/store.test.ts
git commit -m "test: verify runtime ownership domain refactor"
```
