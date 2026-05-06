# Runtime DI Singleton Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert runtime singleton-like collaborators into explicit injectable singleton classes, starting with `RuntimeOwnershipState`, and remove duplicated binding-runnable rules from `RelayRuntime` and `RuntimeAssignmentCoordinator`.

**Architecture:** This slice does not redesign scheduler behavior or runtime assembly. It focuses on structural cleanup with stable behavior: `RuntimeOwnershipState` becomes an injectable in-memory class behind the existing token, runtime singletons stop using `toDynamicValue(() => new ...)`, and a dedicated `RuntimeBindingPolicy` becomes the only source of truth for runtime binding eligibility checks.

**Tech Stack:** TypeScript, Node.js test runner, Inversify, OpenClaw compatibility runtime, Prisma/SQLite test harness

---

## File Structure

- Create: `apps/gateway/src/runtime/runtime-binding-policy.ts`
  Centralize the "is this binding runnable?" rule used by runtime assignment and connection orchestration.

- Modify: `apps/gateway/src/runtime/ownership-state.ts`
  Replace the closure factory with an injectable singleton class while preserving the current token boundary and ownership behavior.

- Modify: `apps/gateway/src/container/modules/runtime.ts`
  Replace runtime `toDynamicValue(() => new ...)` bindings with direct singleton class bindings and token-to-service wiring.

- Modify: `apps/gateway/src/runtime/agent-client-registry.ts`
  Turn the registry into an injectable singleton class that depends on a singleton transport registry abstraction.

- Modify: `apps/gateway/src/runtime/transport-registry-provider.ts`
  Rename or reshape this file into a singleton transport registry class instead of a fake provider.

- Modify: `apps/gateway/src/runtime/runtime-node-state.ts`
  Make node runtime state injectable via constructor injection from gateway config rather than dynamic binding.

- Modify: `apps/gateway/src/runtime/local-node-runtime-state-store.ts`
  Mark the store as an injectable singleton class.

- Modify: `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`
  Make the coordinator injectable and inject the new binding policy.

- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
  Inject the new binding policy and consume the class-based ownership state without changing public behavior.

- Modify: `apps/gateway/src/runtime/runtime-bootstrapper.ts`
  Keep wiring consistent after the singleton cleanup.

- Modify: `apps/gateway/src/container/container.test.ts`
  Add container-level assertions for singleton runtime collaborators and token-to-service bindings.

- Modify: `apps/gateway/src/store/store.test.ts`
  Add focused runtime regression tests for ownership-state behavior and binding-policy consistency.

## Task 1: Convert `RuntimeOwnershipState` Into An Injectable Singleton Class

**Files:**
- Modify: `apps/gateway/src/runtime/ownership-state.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing ownership-state singleton tests**

Add focused tests to `apps/gateway/src/store/store.test.ts` near the existing runtime ownership tests:

```ts
test("InMemoryRuntimeOwnershipState preserves current ownership transition behavior", () => {
  const state = new InMemoryRuntimeOwnershipState();
  const binding = {
    id: "binding-1",
    name: "Primary Binding",
    channelType: "feishu",
    accountId: "default",
    channelConfig: { appId: "cli_1", appSecret: "sec_1" },
    agentId: "agent-1",
    enabled: true,
    createdAt: "2026-04-22T00:00:00.000Z",
  };

  const decision = state.upsertBinding(binding, {
    forceRestart: false,
    hasActiveConnection: false,
    runnable: true,
  });

  assert.deepEqual(decision, {
    publishSnapshot: true,
    shouldRestart: true,
    shouldStop: false,
  });
  assert.equal(state.getOwnedBinding(binding.id)?.binding.agentId, "agent-1");
});

test("RuntimeOwnershipStateToken can point at the injectable ownership singleton", () => {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(InMemoryRuntimeOwnershipState).toSelf().inSingletonScope();
  container.bind(RuntimeOwnershipStateToken).toService(InMemoryRuntimeOwnershipState);

  const first = container.get<RuntimeOwnershipState>(RuntimeOwnershipStateToken);
  const second = container.get<RuntimeOwnershipState>(RuntimeOwnershipStateToken);

  assert.strictEqual(first, second);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "ownership"
```

Expected:

```text
not ok ... InMemoryRuntimeOwnershipState
error: InMemoryRuntimeOwnershipState is not defined
```

- [ ] **Step 3: Replace the factory with an injectable class**

Update `apps/gateway/src/runtime/ownership-state.ts` to export an injectable singleton class behind the existing token:

```ts
@injectable()
export class InMemoryRuntimeOwnershipState implements RuntimeOwnershipState {
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly bindings = new Map<string, OwnedRuntimeBindingRecord>();

  constructor(@unmanaged() options: CreateRuntimeOwnershipStateOptions = {}) {
    this.reconnectPolicy = options.reconnectPolicy ?? createReconnectPolicy();
  }

  upsertBinding(
    binding: ChannelBinding,
    options: RuntimeOwnershipUpsertOptions,
  ): RuntimeOwnershipUpsertResult {
    // move the current closure implementation here without behavior changes
  }

  releaseBinding(bindingId: string): boolean {
    // move the current closure implementation here without behavior changes
  }

  getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined {
    // return cloned record
  }

  listOwnedBindings(): OwnedRuntimeBinding[] {
    // return cloned sorted records
  }

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    // return cloned sorted statuses
  }

  scheduleReconnect(
    bindingId: string,
    delayMs: number,
    callback: () => void | Promise<void>,
  ): void {
    // move the current timer logic here
  }

  clearReconnect(bindingId: string): void {
    // move the current timer clearing logic here
  }

  markIdle(bindingId: string): RuntimeConnectionStatus {
    // move the current status transition logic here
  }

  markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
    // move the current status transition logic here
  }

  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
    // move the current status transition logic here
  }

  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision {
    // move the current status transition logic here
  }

  markError(
    bindingId: string,
    error: unknown,
    agentUrl?: string,
  ): ReconnectDecision {
    // move the current status transition logic here
  }
}
```

- [ ] **Step 4: Preserve the factory as a compatibility wrapper**

Keep `createRuntimeOwnershipState()` as a thin adapter in the same file so existing tests and code paths do not break mid-slice:

```ts
export function createRuntimeOwnershipState(
  options: CreateRuntimeOwnershipStateOptions = {},
): RuntimeOwnershipState {
  return new InMemoryRuntimeOwnershipState(options);
}
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "ownership"
```

Expected:

```text
ok ... InMemoryRuntimeOwnershipState preserves current ownership transition behavior
ok ... RuntimeOwnershipStateToken can point at the injectable ownership singleton
```

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/ownership-state.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: class-ify runtime ownership state"
```

## Task 2: Replace Runtime `toDynamicValue(new ...)` Bindings With Direct Singleton Classes

**Files:**
- Modify: `apps/gateway/src/container/modules/runtime.ts`
- Modify: `apps/gateway/src/runtime/transport-registry-provider.ts`
- Modify: `apps/gateway/src/runtime/agent-client-registry.ts`
- Modify: `apps/gateway/src/runtime/runtime-node-state.ts`
- Modify: `apps/gateway/src/runtime/local-node-runtime-state-store.ts`
- Modify: `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`
- Modify: `apps/gateway/src/container/container.test.ts`

- [ ] **Step 1: Write the failing container singleton assertions**

Add assertions to `apps/gateway/src/container/container.test.ts`:

```ts
test("runtime singleton collaborators resolve through direct singleton bindings", () => {
  const container = buildGatewayContainer(buildGatewayConfig({ port: 7901 }));

  assert.strictEqual(
    container.get(InMemoryRuntimeOwnershipState),
    container.get(InMemoryRuntimeOwnershipState),
  );
  assert.strictEqual(
    container.get<RuntimeOwnershipState>(RuntimeOwnershipStateToken),
    container.get<RuntimeOwnershipState>(RuntimeOwnershipStateToken),
  );
  assert.strictEqual(
    container.get(DefaultTransportRegistry),
    container.get(DefaultTransportRegistry),
  );
  assert.strictEqual(
    container.get(AgentClientRegistry),
    container.get(AgentClientRegistry),
  );
  assert.strictEqual(
    container.get(RuntimeAssignmentCoordinator),
    container.get(RuntimeAssignmentCoordinator),
  );
});
```

- [ ] **Step 2: Run the container test and verify it fails**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts --test-name-pattern "runtime singleton collaborators"
```

Expected:

```text
not ok ... runtime singleton collaborators resolve through direct singleton bindings
error: No bindings found for service: InMemoryRuntimeOwnershipState
```

- [ ] **Step 3: Convert runtime singleton collaborators to injectable classes**

Make these changes:

```ts
// apps/gateway/src/runtime/local-node-runtime-state-store.ts
@injectable()
export class LocalNodeRuntimeStateStore implements NodeRuntimeStateStore {
  // existing implementation unchanged
}

// apps/gateway/src/runtime/runtime-node-state.ts
@injectable()
export class RuntimeNodeState {
  constructor(@inject(GatewayConfigToken) private readonly config: GatewayConfig) {}
}

// apps/gateway/src/runtime/transport-registry-provider.ts
@injectable()
export class DefaultTransportRegistry {
  readonly transportRegistry = new TransportRegistry();

  constructor() {
    this.transportRegistry.register(new A2ATransport());
    this.transportRegistry.register(new ACPTransport());
  }
}

// apps/gateway/src/runtime/agent-client-registry.ts
@injectable()
export class AgentClientRegistry {
  constructor(
    @inject(DefaultTransportRegistry)
    transportProvider: DefaultTransportRegistry,
  ) {
    this.transportRegistry = transportProvider.transportRegistry;
  }
}

// apps/gateway/src/runtime/runtime-assignment-coordinator.ts
@injectable()
export class RuntimeAssignmentCoordinator {
  constructor(
    @inject(RelayRuntime) private readonly runtime: RelayRuntime,
    @inject(RuntimeBindingPolicy) private readonly bindingPolicy: RuntimeBindingPolicy,
    @unmanaged() private readonly options: RuntimeAssignmentCoordinatorOptions = {},
  ) {}
}
```

- [ ] **Step 4: Replace dynamic container bindings with direct singleton bindings**

Update `apps/gateway/src/container/modules/runtime.ts`:

```ts
bind(LocalNodeRuntimeStateStore).toSelf().inSingletonScope();
bind(NodeRuntimeStateStoreToken).toService(LocalNodeRuntimeStateStore);

bind(InMemoryRuntimeOwnershipState).toSelf().inSingletonScope();
bind(RuntimeOwnershipStateToken).toService(InMemoryRuntimeOwnershipState);

bind(DefaultTransportRegistry).toSelf().inSingletonScope();
bind(RuntimeNodeState).toSelf().inSingletonScope();
bind(AgentClientRegistry).toSelf().inSingletonScope();
bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
```

- [ ] **Step 5: Run the container tests and verify they pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts
```

Expected:

```text
ok ... runtime singleton collaborators resolve through direct singleton bindings
ok ... runtime wiring resolves relay runtime dependencies
```

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/container/modules/runtime.ts apps/gateway/src/runtime/transport-registry-provider.ts apps/gateway/src/runtime/agent-client-registry.ts apps/gateway/src/runtime/runtime-node-state.ts apps/gateway/src/runtime/local-node-runtime-state-store.ts apps/gateway/src/runtime/runtime-assignment-coordinator.ts apps/gateway/src/container/container.test.ts
git commit -m "refactor: use direct singleton bindings for runtime services"
```

## Task 3: Extract `RuntimeBindingPolicy` And Remove Duplicated Runnable Checks

**Files:**
- Create: `apps/gateway/src/runtime/runtime-binding-policy.ts`
- Modify: `apps/gateway/src/runtime/relay-runtime.ts`
- Modify: `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`
- Modify: `apps/gateway/src/container/modules/runtime.ts`
- Modify: `apps/gateway/src/store/store.test.ts`

- [ ] **Step 1: Write the failing policy and integration tests**

Add tests to `apps/gateway/src/store/store.test.ts`:

```ts
test("RuntimeBindingPolicy rejects feishu bindings without credentials", () => {
  const policy = new RuntimeBindingPolicy();

  assert.equal(
    policy.isRunnable({
      id: "binding-1",
      name: "Broken",
      channelType: "feishu",
      accountId: "default",
      channelConfig: {},
      agentId: "agent-1",
      enabled: true,
      createdAt: "2026-04-22T00:00:00.000Z",
    }),
    false,
  );
});

test("RelayRuntime and RuntimeAssignmentCoordinator use the same runnable policy", async () => {
  const policy = new RuntimeBindingPolicy();

  assert.equal(
    policy.isRunnable({
      id: "binding-1",
      name: "Healthy",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: "2026-04-22T00:00:00.000Z",
    }),
    true,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RuntimeBindingPolicy"
```

Expected:

```text
not ok ... RuntimeBindingPolicy rejects feishu bindings without credentials
error: RuntimeBindingPolicy is not defined
```

- [ ] **Step 3: Create the policy class and inject it**

Create `apps/gateway/src/runtime/runtime-binding-policy.ts`:

```ts
import { injectable } from "inversify";
import type { ChannelBinding } from "@agent-relay/core";

@injectable()
export class RuntimeBindingPolicy {
  isRunnable(binding: Pick<ChannelBinding, "channelType" | "channelConfig">): boolean {
    if (binding.channelType !== "feishu" && binding.channelType !== "lark") {
      return true;
    }

    const config = binding.channelConfig as {
      appId?: unknown;
      appSecret?: unknown;
    };

    return (
      typeof config.appId === "string" &&
      config.appId.trim().length > 0 &&
      typeof config.appSecret === "string" &&
      config.appSecret.trim().length > 0
    );
  }
}
```

Update runtime consumers:

```ts
// relay-runtime.ts
constructor(
  // existing deps...
  @inject(RuntimeBindingPolicy)
  private readonly bindingPolicy: RuntimeBindingPolicy,
) {}

// replace this.isRunnableBinding(binding)
this.bindingPolicy.isRunnable(binding)

// runtime-assignment-coordinator.ts
if (!binding.enabled || !agent || !this.bindingPolicy.isRunnable(binding)) {
  continue;
}
```

- [ ] **Step 4: Bind the policy in the runtime container**

Update `apps/gateway/src/container/modules/runtime.ts`:

```ts
bind(RuntimeBindingPolicy).toSelf().inSingletonScope();
```

- [ ] **Step 5: Run regression tests and verify they pass**

Run:

```bash
cd /Users/feng/Projects/agent-relay && pnpm test
cd /Users/feng/Projects/agent-relay/apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts --test-name-pattern "RuntimeBindingPolicy|ownership|relay runtime"
```

Expected:

```text
PASS apps/gateway runtime and store tests
ok ... RuntimeBindingPolicy rejects feishu bindings without credentials
ok ... relay runtime assignment tests
```

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/runtime-binding-policy.ts apps/gateway/src/runtime/relay-runtime.ts apps/gateway/src/runtime/runtime-assignment-coordinator.ts apps/gateway/src/container/modules/runtime.ts apps/gateway/src/store/store.test.ts
git commit -m "refactor: centralize runtime binding policy"
```

## Self-Review

- Spec coverage: this plan implements the first execution slice from the spec only: `RuntimeOwnershipState` class conversion, runtime singleton binding cleanup, and `RuntimeBindingPolicy` extraction.
- Placeholder scan: no `TBD`, `TODO`, or deferred implementation markers remain.
- Type consistency: the plan consistently uses `InMemoryRuntimeOwnershipState`, `DefaultTransportRegistry`, and `RuntimeBindingPolicy` across container, runtime, and tests.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-runtime-di-singleton-boundaries.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
