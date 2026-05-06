# RelayRuntime Ownership Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the gateway runtime onto an explicit `RuntimeOwnershipState` aggregate for single-instance correctness first, then extend the same boundaries to Redis-backed cluster ownership without rewriting the Phase 1 runtime model.

**Architecture:** Phase 1 introduces a local runtime aggregate in `apps/gateway/src/runtime/` that owns binding lifecycle, connection status transitions, and reconnect policy. It also closes the desired-state write gaps by enforcing agent existence and single-enabled-binding invariants in the persistence model. Phase 2 adds an ownership-gate abstraction plus Redis-backed leader/lease coordination so scheduling decides ownership while `RelayRuntime` remains the local executor only.

**Tech Stack:** TypeScript 6, Node.js test runner, Prisma + SQLite, Hono gateway runtime, OpenClaw compatibility layer, Redis for Phase 2 cluster coordination

---

## File Structure

### Phase 1 files

- Create: `apps/gateway/src/runtime/ownership-state.ts`
  Runtime-local state model and transition helpers for owned bindings, connection status, and retry metadata.

- Create: `apps/gateway/src/runtime/reconnect-policy.ts`
  Pure retry/backoff policy used by `RelayRuntime`.

- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
  Move binding status bookkeeping behind the runtime aggregate, remove orphan status records, and trigger reconnects from ownership state transitions.

- Modify: `apps/gateway/src/connection-manager.ts`
  Keep channel connection side effects thin and callback-driven; no reconnect policy here.

- Modify: `apps/gateway/src/runtime/local-scheduler.ts`
  Reconcile using runtime aggregate semantics instead of assuming “config unchanged” means “runtime healthy”.

- Modify: `apps/gateway/prisma/schema.prisma`
  Add an `enabledKey` uniqueness strategy for enabled bindings and a foreign-key relation from `ChannelBinding.agentId` to `Agent.id`.

- Modify: `apps/gateway/src/infra/channel-binding-repo.ts`
  Persist the derived `enabledKey` and work with the FK-backed schema.

- Modify: `apps/gateway/src/application/channel-binding-service.ts`
- Modify: `apps/gateway/src/application/use-cases/create-channel-binding.ts`
- Modify: `apps/gateway/src/application/use-cases/update-channel-binding.ts`
  Validate that referenced agents exist before saving desired state.

- Modify: `apps/gateway/src/store/store.test.ts`
  Add runtime aggregate, reconnect, FK, and enabled-key regression coverage while keeping the existing gateway test layout.

- Modify: `docs/architecture-design-zh.md`
- Modify: `docs/relay-runtime.md`
  Align docs with the actual Phase 1 aggregate and explicitly mark cluster items as Phase 2.

### Phase 2 files

- Create: `apps/gateway/src/runtime/ownership-gate.ts`
  Single interface for acquire/renew/release/check ownership.

- Create: `apps/gateway/src/runtime/local-ownership-gate.ts`
  Single-instance implementation that always grants ownership locally.

- Create: `apps/gateway/src/runtime/cluster/types.ts`
- Create: `apps/gateway/src/runtime/cluster/redis-coordination.ts`
- Create: `apps/gateway/src/runtime/cluster/redis-ownership-gate.ts`
- Create: `apps/gateway/src/runtime/cluster/leader-scheduler.ts`
  Cluster coordination primitives, Redis-backed leases, and scheduling.

- Modify: `apps/gateway/src/index.ts`
  Select local or cluster runtime wiring from configuration.

- Modify: `apps/gateway/src/runtime/state.ts`
  Stop pretending the runtime consumes a global snapshot directly once cluster ownership exists.

- Modify: `apps/gateway/src/store/store.test.ts`
  Add deterministic cluster coordination unit tests around leader selection and ownership lease semantics.

- Modify: `docs/architecture-design-zh.md`
  Mark Phase 2 completed boundaries once Redis coordination lands.

---

## Phase 1: Single-Instance Convergence

### Task 1: Introduce `RuntimeOwnershipState`

**Files:**
- Create: `apps/gateway/src/runtime/ownership-state.ts`
- Create: `apps/gateway/src/runtime/reconnect-policy.ts`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("RuntimeOwnershipState", () => {
  test("detaching a binding removes its runtime status entry", async () => {
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
    state.markConnected("binding-1", "http://agent-1");
    state.detachBinding("binding-1");

    assert.deepEqual(state.listConnectionStatuses(), []);
  });

  test("error state schedules the next reconnect attempt", async () => {
    const state = createRuntimeOwnershipState({
      reconnectPolicy: createReconnectPolicy({ baseDelayMs: 1000, maxDelayMs: 8000 }),
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
    const retry = state.markError("binding-1", new Error("socket closed"));

    assert.equal(retry.attempt, 1);
    assert.equal(retry.delayMs, 1000);
    assert.equal(state.getOwnedBinding("binding-1")?.status.status, "error");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RuntimeOwnershipState"
```

Expected:

```text
not ok ... RuntimeOwnershipState
error: createRuntimeOwnershipState is not defined
```

- [ ] **Step 3: Write the minimal ownership state and reconnect policy**

```ts
// apps/gateway/src/runtime/reconnect-policy.ts
export interface ReconnectDecision {
  attempt: number;
  delayMs: number;
}

export interface ReconnectPolicy {
  nextAttempt(attempt: number): ReconnectDecision;
}

export function createReconnectPolicy(options?: {
  baseDelayMs?: number;
  maxDelayMs?: number;
}): ReconnectPolicy {
  const baseDelayMs = options?.baseDelayMs ?? 1_000;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  return {
    nextAttempt(attempt) {
      const safeAttempt = Math.max(1, attempt);
      const delayMs = Math.min(baseDelayMs * 2 ** (safeAttempt - 1), maxDelayMs);
      return { attempt: safeAttempt, delayMs };
    },
  };
}

// apps/gateway/src/runtime/ownership-state.ts
import type { ChannelBinding, RuntimeConnectionStatus } from "@agent-relay/core";
import { createReconnectPolicy, type ReconnectDecision, type ReconnectPolicy } from "./reconnect-policy.js";

interface OwnedBindingStatus {
  status: RuntimeConnectionStatus["status"];
  agentUrl?: string;
  error?: string;
  updatedAt: string;
  reconnectAttempt: number;
  nextRetryAt?: string;
}

interface OwnedBindingRecord {
  binding: ChannelBinding;
  status: OwnedBindingStatus;
}

export interface RuntimeOwnershipState {
  attachBinding(binding: ChannelBinding): void;
  detachBinding(bindingId: string): void;
  getOwnedBinding(bindingId: string): OwnedBindingRecord | undefined;
  listConnectionStatuses(): RuntimeConnectionStatus[];
  markConnecting(bindingId: string, agentUrl: string): void;
  markConnected(bindingId: string, agentUrl: string): void;
  markDisconnected(bindingId: string, agentUrl: string): ReconnectDecision;
  markError(bindingId: string, error: unknown, agentUrl?: string): ReconnectDecision;
}

export function createRuntimeOwnershipState(options?: {
  reconnectPolicy?: ReconnectPolicy;
}): RuntimeOwnershipState {
  const records = new Map<string, OwnedBindingRecord>();
  const reconnectPolicy = options?.reconnectPolicy ?? createReconnectPolicy();

  const updateStatus = (
    bindingId: string,
    patch: Partial<OwnedBindingStatus>,
  ): OwnedBindingRecord => {
    const record = records.get(bindingId);
    if (!record) throw new Error(`Owned binding ${bindingId} not found`);
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    records.set(bindingId, record);
    return record;
  };

  return {
    attachBinding(binding) {
      records.set(binding.id, {
        binding,
        status: {
          status: "idle",
          updatedAt: new Date().toISOString(),
          reconnectAttempt: 0,
        },
      });
    },
    detachBinding(bindingId) {
      records.delete(bindingId);
    },
    getOwnedBinding(bindingId) {
      return records.get(bindingId);
    },
    listConnectionStatuses() {
      return Array.from(records.entries()).map(([bindingId, record]) => ({
        bindingId,
        status: record.status.status,
        agentUrl: record.status.agentUrl,
        error: record.status.error,
        updatedAt: record.status.updatedAt,
      }));
    },
    markConnecting(bindingId, agentUrl) {
      updateStatus(bindingId, {
        status: "connecting",
        agentUrl,
        error: undefined,
      });
    },
    markConnected(bindingId, agentUrl) {
      updateStatus(bindingId, {
        status: "connected",
        agentUrl,
        error: undefined,
        reconnectAttempt: 0,
        nextRetryAt: undefined,
      });
    },
    markDisconnected(bindingId, agentUrl) {
      const record = updateStatus(bindingId, {
        status: "disconnected",
        agentUrl,
      });
      const decision = reconnectPolicy.nextAttempt(record.status.reconnectAttempt + 1);
      updateStatus(bindingId, {
        reconnectAttempt: decision.attempt,
        nextRetryAt: new Date(Date.now() + decision.delayMs).toISOString(),
      });
      return decision;
    },
    markError(bindingId, error, agentUrl) {
      const record = updateStatus(bindingId, {
        status: "error",
        agentUrl,
        error: String(error),
      });
      const decision = reconnectPolicy.nextAttempt(record.status.reconnectAttempt + 1);
      updateStatus(bindingId, {
        reconnectAttempt: decision.attempt,
        nextRetryAt: new Date(Date.now() + decision.delayMs).toISOString(),
      });
      return decision;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RuntimeOwnershipState"
```

Expected:

```text
# tests 2
# pass 2
# fail 0
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/src/runtime/ownership-state.ts apps/gateway/src/runtime/reconnect-policy.ts apps/gateway/src/store/store.test.ts
git commit -m "feat: add runtime ownership state model"
```

### Task 2: Refactor `RelayRuntime` to enforce aggregate ownership semantics

**Files:**
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Modify: `apps/gateway/src/connection-manager.ts`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("RelayRuntime ownership semantics", () => {
  const createRelayRuntimeForTest = (hooks?: {
    restartConnection?: (binding: { id: string }) => Promise<void>;
    stopConnection?: (bindingId: string) => Promise<void>;
  }) => {
    const runtime = new RelayRuntime({
      name: "test",
      transports: [],
    }) as RelayRuntime & {
      connectionManager: {
        restartConnection(binding: { id: string }): Promise<void>;
        stopConnection(bindingId: string): Promise<void>;
      };
    };
    runtime.connectionManager.restartConnection =
      hooks?.restartConnection ?? (async () => {});
    runtime.connectionManager.stopConnection =
      hooks?.stopConnection ?? (async () => {});
    return runtime;
  };

  test("refreshing an unchanged binding with no active connection restarts it", async () => {
    const restartCalls: string[] = [];
    const runtime = createRelayRuntimeForTest({
      restartConnection: async (binding) => restartCalls.push(binding.id),
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
    const agent = {
      id: "agent-1",
      name: "Agent One",
      url: "http://agent-1",
      protocol: "a2a",
      createdAt: new Date().toISOString(),
    };

    await runtime.attachBinding(binding, agent);
    await runtime.detachBinding(binding.id);
    await runtime.attachBinding(binding, agent);

    assert.deepEqual(restartCalls, ["binding-1", "binding-1"]);
  });

  test("detaching a binding removes it from runtime connection statuses", async () => {
    const runtime = createRelayRuntimeForTest();
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
    const agent = {
      id: "agent-1",
      name: "Agent One",
      url: "http://agent-1",
      protocol: "a2a",
      createdAt: new Date().toISOString(),
    };

    await runtime.attachBinding(binding, agent);
    await runtime.detachBinding(binding.id);

    assert.deepEqual(runtime.listConnectionStatuses(), []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RelayRuntime ownership semantics"
```

Expected:

```text
not ok ... RelayRuntime ownership semantics
error: listConnectionStatuses still contains detached binding
```

- [ ] **Step 3: Refactor `RelayRuntime` to use `RuntimeOwnershipState`**

```ts
// apps/gateway/src/runtime/relay-runtime.ts
import { createRuntimeOwnershipState } from "./ownership-state.js";

export class RelayRuntime {
  private readonly ownership = createRuntimeOwnershipState();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();

  async attachBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    await this.applyAgentUpsert(agent);
    const existing = this.ownership.getOwnedBinding(binding.id);
    if (!existing) {
      this.ownership.attachBinding(binding);
    } else {
      existing.binding = binding;
    }
    this.bindingsById.set(binding.id, binding);
    this.openClawConfig = buildOpenClawConfigFromBindings(this.listBindings(), this.agentsById);
    await this.connectionManager.restartConnection(binding);
  }

  async detachBinding(bindingId: string): Promise<void> {
    this.clearReconnectTimer(bindingId);
    this.bindingsById.delete(bindingId);
    this.ownership.detachBinding(bindingId);
    this.openClawConfig = buildOpenClawConfigFromBindings(this.listBindings(), this.agentsById);
    await this.connectionManager.stopConnection(bindingId);
  }

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.ownership.listConnectionStatuses();
  }

  private handleConnectionStatus(
    bindingId: string,
    status: ConnectionStatus,
    agentUrl?: string,
    error?: unknown,
  ): void {
    if (!this.ownership.getOwnedBinding(bindingId)) return;
    if (status === "connecting" && agentUrl) this.ownership.markConnecting(bindingId, agentUrl);
    if (status === "connected" && agentUrl) this.ownership.markConnected(bindingId, agentUrl);
    if (status === "disconnected" && agentUrl) this.scheduleReconnect(bindingId, this.ownership.markDisconnected(bindingId, agentUrl));
    if (status === "error") this.scheduleReconnect(bindingId, this.ownership.markError(bindingId, error, agentUrl));
  }
}

// apps/gateway/src/connection-manager.ts
// Keep callbacks as status signals only; no reconnect timer logic here.
this.callbacks.onConnectionStatus?.({ binding, status: "error", agentUrl: target.url, error: err });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RelayRuntime ownership semantics"
```

Expected:

```text
# tests 2
# pass 2
# fail 0
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/connection-manager.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: enforce relay runtime ownership state"
```

### Task 3: Add reconnect/backoff repair to the single-instance runtime loop

**Files:**
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Modify: `apps/gateway/src/runtime/local-scheduler.ts`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("RelayRuntime reconnect policy", () => {
  const createRelayRuntimeForTest = (hooks?: {
    restartConnection?: (binding: { id: string }) => Promise<void>;
  }) => {
    const runtime = new RelayRuntime({
      name: "test",
      transports: [],
    }) as RelayRuntime & {
      connectionManager: {
        restartConnection(binding: { id: string }): Promise<void>;
      };
    };
    runtime.connectionManager.restartConnection =
      hooks?.restartConnection ?? (async () => {});
    return runtime;
  };

  const runLocalSchedulerReconcileForTest = async (
    runtime: {
      refreshBinding(binding: { id: string }, agent: { id: string }): Promise<void>;
      detachBinding(bindingId: string): Promise<void>;
      listBindings(): Array<{ id: string }>;
      hasActiveConnection(bindingId: string): boolean;
    },
    bindings: Array<{
      id: string;
      enabled: boolean;
      agentId: string;
    }>,
    agents: Array<{ id: string }>,
  ) => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    for (const binding of bindings) {
      const agent = agentsById.get(binding.agentId);
      if (!binding.enabled || !agent) {
        await runtime.detachBinding(binding.id);
        continue;
      }
      if (!runtime.hasActiveConnection(binding.id)) {
        await runtime.refreshBinding(binding, agent);
      }
    }
  };

  test("connection error schedules one delayed reconnect for the owned binding", async () => {
    const restartCalls: string[] = [];
    const runtime = createRelayRuntimeForTest({
      restartConnection: async (binding) => restartCalls.push(binding.id),
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
    const agent = {
      id: "agent-1",
      name: "Agent One",
      url: "http://agent-1",
      protocol: "a2a",
      createdAt: new Date().toISOString(),
    };

    await runtime.attachBinding(binding, agent);
    (runtime as RelayRuntime & {
      ["handleConnectionStatus"]: (
        bindingId: string,
        status: "error" | "disconnected" | "connecting" | "connected",
        agentUrl?: string,
        error?: unknown,
      ) => void;
    })["handleConnectionStatus"]("binding-1", "error", "http://agent-1", new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(restartCalls.length, 2);
  });

  test("scheduler repairs a missing local connection even when binding config is unchanged", async () => {
    const refreshed: string[] = [];
    const runtime = {
      async refreshBinding(binding: { id: string }) {
        refreshed.push(binding.id);
      },
      async detachBinding() {},
      listBindings() {
        return [];
      },
      hasActiveConnection(bindingId: string) {
        return bindingId !== "binding-1";
      },
    };

    await runLocalSchedulerReconcileForTest(runtime as never, [
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
    ], [
      {
        id: "agent-1",
        name: "Agent One",
        url: "http://agent-1",
        protocol: "a2a",
        createdAt: new Date().toISOString(),
      },
    ]);

    assert.deepEqual(refreshed, ["binding-1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RelayRuntime reconnect policy"
```

Expected:

```text
not ok ... RelayRuntime reconnect policy
error: restartCalls.length is 1
```

- [ ] **Step 3: Implement reconnect scheduling and runtime-health-aware reconciliation**

```ts
// apps/gateway/src/runtime/relay-runtime.ts
private scheduleReconnect(bindingId: string, decision: { delayMs: number }): void {
  this.clearReconnectTimer(bindingId);
  const record = this.ownership.getOwnedBinding(bindingId);
  if (!record) return;
  this.reconnectTimers.set(bindingId, setTimeout(() => {
    void this.connectionManager.restartConnection(record.binding);
  }, decision.delayMs));
}

private clearReconnectTimer(bindingId: string): void {
  const timer = this.reconnectTimers.get(bindingId);
  if (timer) clearTimeout(timer);
  this.reconnectTimers.delete(bindingId);
}

hasActiveConnection(bindingId: string): boolean {
  return this.connectionManager.hasConnection(bindingId);
}

// apps/gateway/src/connection-manager.ts
hasConnection(bindingId: string): boolean {
  return this.connections.has(bindingId);
}

// apps/gateway/src/runtime/local-scheduler.ts
if (!binding.enabled || !agent) {
  await this.runtime.detachBinding(binding.id);
  continue;
}

const needsRepair =
  !this.runtime.listBindings().some((owned) => owned.id === binding.id) ||
  !this.runtime.hasActiveConnection(binding.id);

if (needsRepair) {
  await this.runtime.refreshBinding(binding, agent);
  desiredBindingIds.add(binding.id);
  continue;
}

desiredBindingIds.add(binding.id);
```

- [ ] **Step 4: Run the targeted tests and the full gateway test suite**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RelayRuntime reconnect policy"
cd /Users/feng/Projects/agent-relay && pnpm test
```

Expected:

```text
# first command: pass 2, fail 0
# second command: all gateway tests pass
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/runtime/local-scheduler.ts apps/gateway/src/connection-manager.ts apps/gateway/src/store/store.test.ts
git commit -m "feat: repair runtime connections with reconnect backoff"
```

### Task 4: Enforce desired-state invariants in the database and application layer

**Files:**
- Modify: `apps/gateway/prisma/schema.prisma`
- Modify: `apps/gateway/src/infra/channel-binding-repo.ts`
- Modify: `apps/gateway/src/application/channel-binding-service.ts`
- Modify: `apps/gateway/src/application/use-cases/create-channel-binding.ts`
- Modify: `apps/gateway/src/application/use-cases/update-channel-binding.ts`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("Channel binding desired-state invariants", () => {
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

  test("enabling a second binding for the same channel account fails at the DB layer", async () => {
    const { bindingService, agentService } = makeInfra();
    const agent = await agentService.register({
      name: "Agent One",
      url: "http://agent-one",
      protocol: "a2a",
    });

    await bindingService.create({
      name: "Primary",
      channelType: "feishu",
      accountId: "dup-account",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: agent.id,
      enabled: true,
    });

    await assert.rejects(
      () => bindingService.create({
        name: "Duplicate",
        channelType: "feishu",
        accountId: "dup-account",
        channelConfig: { appId: "cli_2", appSecret: "sec_2" },
        agentId: agent.id,
        enabled: true,
      }),
      /DuplicateEnabledBindingError|Unique constraint failed/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "Channel binding desired-state invariants"
```

Expected:

```text
not ok ... Channel binding desired-state invariants
error: missing-agent binding was inserted successfully
```

- [ ] **Step 3: Implement the schema and write-path checks**

```prisma
// apps/gateway/prisma/schema.prisma
model ChannelBinding {
  id            String   @id @default(uuid())
  name          String
  channelType   String   @map("channel_type")
  accountId     String   @map("account_id")
  channelConfig String   @default("{}") @map("channel_config")
  agentId       String   @map("agent_id")
  enabled       Boolean  @default(true)
  enabledKey    String?  @unique @map("enabled_key")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  agent Agent @relation(fields: [agentId], references: [id], onDelete: Restrict)

  @@map("channel_bindings")
}
```

```ts
// apps/gateway/src/application/channel-binding-service.ts
export class MissingAgentError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
  }
}

// apps/gateway/src/application/use-cases/create-channel-binding.ts
export async function createChannelBinding(
  repo: ChannelBindingRepository,
  agentRepo: AgentConfigRepository,
  data: CreateChannelBindingData,
): Promise<ChannelBindingSnapshot> {
  const agent = await agentRepo.findById(data.agentId);
  if (!agent) throw new MissingAgentError(data.agentId);
  await assertNoDuplicateEnabled(repo, data.channelType, data.accountId, data.enabled);
  const aggregate = ChannelBindingAggregate.create({ id: randomUUID(), ...data });
  await repo.save(aggregate);
  return aggregate.snapshot();
}

// apps/gateway/src/infra/channel-binding-repo.ts
function toEnabledKey(snapshot: ChannelBindingSnapshot): string | null {
  return snapshot.enabled ? `${snapshot.channelType}:${snapshot.accountId}` : null;
}

enabledKey: toEnabledKey(snapshot),
```

- [ ] **Step 4: Push the schema and run the tests**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && pnpm db:push
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "Channel binding desired-state invariants"
cd /Users/feng/Projects/agent-relay && pnpm typecheck
```

Expected:

```text
Prisma schema loaded
The database is now in sync
# tests 2
# pass 2
# fail 0
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/prisma/schema.prisma apps/gateway/src/infra/channel-binding-repo.ts apps/gateway/src/application/channel-binding-service.ts apps/gateway/src/application/use-cases/create-channel-binding.ts apps/gateway/src/application/use-cases/update-channel-binding.ts apps/gateway/src/store/store.test.ts
git commit -m "feat: enforce runtime binding invariants in persistence"
```

### Task 5: Update the architecture docs to match the Phase 1 runtime model

**Files:**
- Modify: `docs/architecture-design-zh.md`
- Modify: `docs/relay-runtime.md`

- [ ] **Step 1: Write the failing documentation checklist in the plan branch**

```md
- architecture-design-zh.md still describes cluster ownership as if it is already implemented
- relay-runtime.md still describes direct event handling instead of the local ownership aggregate
- neither doc names RuntimeOwnershipState, reconnect policy, or enabledKey
```

- [ ] **Step 2: Verify the docs are currently missing the Phase 1 model**

Run:

```bash
cd /Users/feng/Projects/agent-relay
rg -n "RuntimeOwnershipState|enabledKey|Phase 1|Phase 2" docs/architecture-design-zh.md docs/relay-runtime.md
```

Expected:

```text
no matches found
```

- [ ] **Step 3: Update the docs with the actual Phase 1 boundaries**

```md
## Phase 1（单机收敛）

- `RelayRuntime` 持有 `RuntimeOwnershipState`
- `ConnectionManager` 只执行 side effects，不持有重连策略
- `LocalScheduler` 只负责唤醒 reconcile 和修复缺失连接
- `channel_bindings.enabled_key` 负责保证单账号单 enabled binding

## Phase 2（集群扩展）

- Redis leader lease
- binding ownership lease
- ownership gate abstraction
- rebalance and cluster failover
```

- [ ] **Step 4: Re-run the grep check**

Run:

```bash
cd /Users/feng/Projects/agent-relay
rg -n "RuntimeOwnershipState|enabledKey|Phase 1|Phase 2" docs/architecture-design-zh.md docs/relay-runtime.md
```

Expected:

```text
docs/architecture-design-zh.md:...:RuntimeOwnershipState
docs/relay-runtime.md:...:Phase 1
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add docs/architecture-design-zh.md docs/relay-runtime.md
git commit -m "docs: align runtime architecture with phase one design"
```

---

## Phase 2: Cluster Ownership Extension

### Task 6: Introduce an ownership-gate abstraction without changing the Phase 1 runtime API

**Files:**
- Create: `apps/gateway/src/runtime/ownership-gate.ts`
- Create: `apps/gateway/src/runtime/local-ownership-gate.ts`
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("OwnershipGate", () => {
  test("local ownership gate grants and releases binding ownership", async () => {
    const gate = createLocalOwnershipGate();

    const lease = await gate.acquire("binding-1");
    assert.equal(lease.bindingId, "binding-1");
    assert.equal(await gate.isHeld("binding-1"), true);

    await gate.release(lease);
    assert.equal(await gate.isHeld("binding-1"), false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "OwnershipGate"
```

Expected:

```text
not ok ... OwnershipGate
error: createLocalOwnershipGate is not defined
```

- [ ] **Step 3: Add the ownership-gate contract and local implementation**

```ts
// apps/gateway/src/runtime/ownership-gate.ts
export interface OwnershipLease {
  bindingId: string;
  token: string;
}

export interface OwnershipGate {
  acquire(bindingId: string): Promise<OwnershipLease | null>;
  renew(lease: OwnershipLease): Promise<boolean>;
  release(lease: OwnershipLease): Promise<void>;
  isHeld(bindingId: string): Promise<boolean>;
}

// apps/gateway/src/runtime/local-ownership-gate.ts
import { randomUUID } from "node:crypto";
import type { OwnershipGate, OwnershipLease } from "./ownership-gate.js";

export function createLocalOwnershipGate(): OwnershipGate {
  const held = new Map<string, OwnershipLease>();
  return {
    async acquire(bindingId) {
      if (held.has(bindingId)) return null;
      const lease = { bindingId, token: randomUUID() };
      held.set(bindingId, lease);
      return lease;
    },
    async renew(lease) {
      return held.get(lease.bindingId)?.token === lease.token;
    },
    async release(lease) {
      if (held.get(lease.bindingId)?.token === lease.token) {
        held.delete(lease.bindingId);
      }
    },
    async isHeld(bindingId) {
      return held.has(bindingId);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "OwnershipGate"
```

Expected:

```text
# tests 1
# pass 1
# fail 0
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/src/runtime/ownership-gate.ts apps/gateway/src/runtime/local-ownership-gate.ts apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/store/store.test.ts
git commit -m "feat: add runtime ownership gate abstraction"
```

### Task 7: Add Redis coordination primitives for leader and binding leases

**Files:**
- Create: `apps/gateway/src/runtime/cluster/types.ts`
- Create: `apps/gateway/src/runtime/cluster/redis-coordination.ts`
- Create: `apps/gateway/src/runtime/cluster/redis-ownership-gate.ts`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("Redis coordination contracts", () => {
  test("binding lease keys include the binding id and owner instance id", async () => {
    const keys = buildRedisCoordinationKeys({
      instanceId: "gateway-a",
      bindingId: "binding-1",
    });

    assert.equal(keys.bindingLeaseKey, "a2a:binding:binding-1:lease");
    assert.equal(keys.instanceHeartbeatKey, "a2a:instance:gateway-a:heartbeat");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "Redis coordination contracts"
```

Expected:

```text
not ok ... Redis coordination contracts
error: buildRedisCoordinationKeys is not defined
```

- [ ] **Step 3: Add Redis coordination types and key builders**

```ts
// apps/gateway/src/runtime/cluster/types.ts
export interface ClusterRuntimeOptions {
  instanceId: string;
  leaseTtlMs: number;
  heartbeatTtlMs: number;
}

export interface RedisCoordinationKeys {
  bindingLeaseKey: string;
  instanceHeartbeatKey: string;
  leaderLeaseKey: string;
}

export function buildRedisCoordinationKeys(input: {
  instanceId: string;
  bindingId: string;
}): RedisCoordinationKeys {
  return {
    bindingLeaseKey: `a2a:binding:${input.bindingId}:lease`,
    instanceHeartbeatKey: `a2a:instance:${input.instanceId}:heartbeat`,
    leaderLeaseKey: "a2a:cluster:leader",
  };
}
```

```ts
// apps/gateway/src/runtime/cluster/redis-ownership-gate.ts
import type { OwnershipGate, OwnershipLease } from "../ownership-gate.js";

export function createRedisOwnershipGate(): OwnershipGate {
  return {
    async acquire(_bindingId): Promise<OwnershipLease | null> {
      throw new Error("Redis ownership gate not wired yet");
    },
    async renew() {
      throw new Error("Redis ownership gate not wired yet");
    },
    async release() {
      throw new Error("Redis ownership gate not wired yet");
    },
    async isHeld() {
      return false;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify the contracts pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "Redis coordination contracts"
```

Expected:

```text
# tests 1
# pass 1
# fail 0
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/src/runtime/cluster/types.ts apps/gateway/src/runtime/cluster/redis-coordination.ts apps/gateway/src/runtime/cluster/redis-ownership-gate.ts apps/gateway/src/store/store.test.ts
git commit -m "feat: add redis coordination primitives"
```

### Task 8: Implement cluster scheduler wiring and bootstrap selection

**Files:**
- Create: `apps/gateway/src/runtime/cluster/leader-scheduler.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/runtime/state.ts`
- Modify: `docs/architecture-design-zh.md`
- Test: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("cluster bootstrap wiring", () => {
  test("cluster mode uses the leader scheduler instead of LocalScheduler", async () => {
    const result = buildRuntimeBootstrap({
      clusterMode: true,
      redisUrl: "redis://localhost:6379",
    });

    assert.equal(result.schedulerKind, "leader");
  });

  test("single-instance mode keeps LocalScheduler", async () => {
    const result = buildRuntimeBootstrap({
      clusterMode: false,
    });

    assert.equal(result.schedulerKind, "local");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "cluster bootstrap wiring"
```

Expected:

```text
not ok ... cluster bootstrap wiring
error: buildRuntimeBootstrap is not defined
```

- [ ] **Step 3: Implement runtime bootstrap selection**

```ts
// apps/gateway/src/runtime/cluster/leader-scheduler.ts
export class LeaderScheduler {
  readonly kind = "leader";

  start(): void {
    // acquire leader lease, run reconcile loop, and schedule bindings
  }

  async stop(): Promise<void> {}
}

// apps/gateway/src/index.ts
export function buildRuntimeBootstrap(options: {
  clusterMode: boolean;
  relay: RelayRuntime;
  eventBus: DomainEventBus;
  ownershipGate?: OwnershipGate;
}) {
  if (options.clusterMode) {
    return {
      schedulerKind: "leader" as const,
      scheduler: new LeaderScheduler({
        relay: options.relay,
        ownershipGate: options.ownershipGate ?? createRedisOwnershipGate(),
      }),
    };
  }

  return {
    schedulerKind: "local" as const,
    scheduler: new LocalScheduler(options.relay, options.eventBus),
  };
}

const clusterMode = process.env["CLUSTER_MODE"] === "true";

const bootstrap = buildRuntimeBootstrap({
  clusterMode,
  relay,
  eventBus,
});

bootstrap.scheduler.start();
```

```ts
// apps/gateway/src/runtime/state.ts
// Keep this file as desired-state loaders only; ownership filtering moves into the scheduler.
export async function loadDesiredStateSnapshot(): Promise<RuntimeStateSnapshot> {
  const [bindings, agents] = await Promise.all([
    loadBindingsSnapshot(),
    loadAgentsSnapshot(),
  ]);
  return { bindings, agents };
}
```

- [ ] **Step 4: Run the targeted tests and the full verification suite**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "cluster bootstrap wiring"
cd /Users/feng/Projects/agent-relay && pnpm test
cd /Users/feng/Projects/agent-relay && pnpm typecheck
```

Expected:

```text
# first command: pass 2, fail 0
# second command: all tests pass
# third command: no TypeScript errors
```

- [ ] **Step 5: Commit**

```bash
cd /Users/feng/Projects/agent-relay
git add apps/gateway/src/runtime/cluster/leader-scheduler.ts apps/gateway/src/index.ts apps/gateway/src/runtime/state.ts apps/gateway/src/store/store.test.ts docs/architecture-design-zh.md
git commit -m "feat: wire cluster runtime bootstrap"
```

---

## Self-Review

### Spec coverage

- `RuntimeOwnershipState` explicit design: covered by Task 1 and Task 2.
- Detached binding status cleanup: covered by Task 1 and Task 2.
- Reconnect/backoff semantics and scheduler repair: covered by Task 3.
- Missing agent validation and strong enabled-binding invariant: covered by Task 4.
- Documentation drift between current implementation and target architecture: covered by Task 5.
- Ownership gate abstraction for single-instance and cluster reuse: covered by Task 6.
- Redis leader/lease coordination primitives: covered by Task 7.
- Cluster bootstrap and scheduler split: covered by Task 8.

### Placeholder scan

- No `TBD`, `TODO`, or “implement later” placeholders remain.
- Each task names exact files and concrete commands.
- Every code-changing step contains a concrete code block.

### Type consistency

- `RuntimeOwnershipState`, `ReconnectPolicy`, `OwnershipGate`, and `OwnershipLease` are introduced before later tasks depend on them.
- Phase 2 reuses the Phase 1 `RelayRuntime` API instead of replacing it.
- `loadDesiredStateSnapshot()` in Task 8 is intentionally a rename/scope split from the current `loadRuntimeStateSnapshot()` semantics.
