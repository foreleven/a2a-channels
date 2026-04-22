# Runtime DI Singleton Boundaries Design

## Context

The gateway runtime has already moved part of its wiring behind Inversify, but the runtime layer still mixes three different patterns:

- real singleton collaborators that are still created through `toDynamicValue(() => new ...)`,
- stateful domain-like objects that are exposed as token + factory closures instead of injectable classes,
- a `RelayRuntime` facade that still owns too many state mutations and side effects.

The current result is structurally inconsistent:

- `RuntimeOwnershipState` is logically a process-wide singleton state container, but it is created by `createRuntimeOwnershipState()` and injected through a token rather than modeled as a class.
- `AgentClientRegistry`, `RuntimeNodeState`, `LocalNodeRuntimeStateStore`, and `RuntimeAssignmentCoordinator` are singleton collaborators in behavior, but the container still treats them as manually constructed values.
- `RelayRuntime` still owns binding assignment decisions, connection-status mutation handling, reconnect scheduling, config rebuilding, and node snapshot publication in one class.
- several helpers outside the main runtime path still bypass DI entirely by doing `new Repository()` directly.

This is why the runtime layer feels unclean even after the first DI pass: the composition root exists, but object lifetime and responsibility boundaries are still blurred.

## Goals

- Convert logically singleton runtime collaborators into injectable singleton classes.
- Promote `RuntimeOwnershipState` from factory-produced closure state into an explicit injectable class.
- Shrink `RelayRuntime` into a thin runtime facade instead of a mutation-heavy god object.
- Remove "fake provider / fake factory" abstractions where the process only ever needs one instance.
- Centralize binding-runnable policy so runtime rules are not duplicated across collaborators.
- Define an incremental migration path that keeps runtime behavior stable while boundaries are cleaned up.

## Non-Goals

- Rebuild the entire runtime around a new event model.
- Change scheduler semantics or introduce new cluster behavior in this design.
- Replace `ConnectionManager` reply dispatch behavior unless required by the runtime split.
- Force every object into container-managed construction when a real runtime factory is still the clearer abstraction.

## Problems To Solve

### 1. Singleton collaborators are disguised as factories

The following objects are semantically singleton within one gateway process:

- runtime ownership state,
- transport registry,
- local node runtime state,
- local node snapshot store,
- agent client registry,
- assignment coordinator.

Today those objects are either created through `toDynamicValue` or returned by a factory function. This hides lifetime semantics and makes the code look more dynamic than it actually is.

### 2. `RuntimeOwnershipState` is stateful enough to deserve a real class

`RuntimeOwnershipState` already owns:

- assigned bindings,
- connection statuses,
- reconnect attempt counters,
- reconnect timers,
- transition helpers for connecting / connected / disconnected / error / idle.

That is not a lightweight helper anymore. It is a real long-lived state object and should be modeled as such.

### 3. `RelayRuntime` still mixes coordination, mutation, and projection

`RelayRuntime` currently does all of these:

- tracks runtime-owned bindings,
- mutates agent caches,
- handles connection lifecycle callbacks,
- schedules reconnects,
- rebuilds OpenClaw config,
- publishes node snapshots,
- executes binding restart and stop side effects.

Even if all of those behaviors are valid somewhere in runtime, they do not belong in one class.

### 4. Binding runnable rules are duplicated

The "is this binding runnable" rule exists in both `RelayRuntime` and `RuntimeAssignmentCoordinator`. This is already a drift risk and should become one explicit policy object.

## Core Decisions

### 1. Model runtime singletons as injectable classes

If an object is process-wide, stateful, and long-lived, it should be represented as an injectable singleton class instead of:

- a token + closure factory,
- a `toDynamicValue(() => new X())` wrapper,
- a provider class whose only job is returning one instance.

This applies first to:

- `RuntimeOwnershipState`,
- `AgentClientRegistry`,
- `RuntimeNodeState`,
- `LocalNodeRuntimeStateStore`,
- `RuntimeAssignmentCoordinator`,
- transport registry wiring.

### 2. Keep real factories only where instance creation is actually dynamic

The codebase should keep provider / factory abstractions only when:

- creation requires per-call runtime parameters,
- multiple instances may be created in one process,
- the object graph has a circular initialization pattern that is clearer with an assembly step.

This means some runtime assembly abstractions may survive temporarily, but they should be judged against real creation needs rather than kept by default.

### 3. `RelayRuntime` becomes a facade over runtime collaborators

`RelayRuntime` should remain the application-facing runtime boundary, but it should stop being the owner of all mutation details.

Its target role is:

- lifecycle entrypoint for bootstrap and shutdown,
- command surface for binding assignment and release,
- read-only facade for owned binding ids and connection statuses,
- holder of assembled runtime infrastructure that does not naturally belong elsewhere.

Detailed state transitions and projections should move to dedicated collaborators.

### 4. Runtime policy and projection logic must be explicit collaborators

The runtime split should produce explicit objects for:

- binding runnable policy,
- OpenClaw config projection,
- node snapshot publication,
- connection-status transition handling,
- agent runtime catalog management.

This keeps business rules out of container modules and out of the `RelayRuntime` shell.

## Target Runtime Shape

### Injectable singleton collaborators

The runtime module should converge on these singleton classes:

- `InMemoryRuntimeOwnershipState`
- `DefaultTransportRegistry`
- `RuntimeNodeState`
- `LocalNodeRuntimeStateStore`
- `AgentClientRegistry`
- `RuntimeAssignmentCoordinator`
- `RuntimeBindingPolicy`
- `OpenClawConfigProjector`
- `RuntimeSnapshotPublisher`
- `RuntimeConnectionStatusHandler`
- `RuntimeAgentCatalog`
- `RelayRuntime`
- `RuntimeClusterStateReader`
- `RuntimeBootstrapper`

The exact names can vary, but the boundaries should match these responsibilities.

### `InMemoryRuntimeOwnershipState`

This class replaces `createRuntimeOwnershipState()`.

Responsibilities:

- own the current set of bindings assigned to this process,
- own exported connection status for each binding,
- own reconnect attempt counters and reconnect timer handles,
- decide whether an updated binding should restart, stop, or remain unchanged,
- expose immutable snapshots of owned bindings and connection statuses.

It remains behind `RuntimeOwnershipStateToken`, but that token should point to a concrete injectable singleton class through `toService(...)`.

### `RuntimeBindingPolicy`

Responsibilities:

- answer whether a binding is runnable,
- keep channel-specific runtime prerequisites in one place,
- eliminate duplicated binding validity logic from `RelayRuntime` and `RuntimeAssignmentCoordinator`.

This object should be pure or near-pure, but making it injectable keeps the dependency graph explicit and allows later policy extension without spreading conditionals again.

### `RuntimeAgentCatalog`

Responsibilities:

- own runtime agent maps,
- update and remove agent entries,
- coordinate `AgentClientRegistry` lifecycle changes,
- provide runtime lookups from agent id to client and url,
- provide a stable agent collection to config projection.

This removes agent bookkeeping from `RelayRuntime`.

### `OpenClawConfigProjector`

Responsibilities:

- build current OpenClaw config from owned bindings plus the runtime agent catalog,
- isolate config rebuilding from runtime command handling,
- give `RelayRuntime` one narrow dependency instead of open-coded rebuilding logic.

### `RuntimeSnapshotPublisher`

Responsibilities:

- build node snapshots from `RuntimeNodeState` and ownership-exported connection statuses,
- serialize publish calls through the current promise queue pattern,
- provide foreground and background publish APIs,
- keep snapshot side effects out of `RelayRuntime`.

### `RuntimeConnectionStatusHandler`

Responsibilities:

- translate connection callbacks into ownership-state mutations,
- apply reconnect policy outcomes,
- schedule reconnect side effects when required,
- trigger snapshot publication after status transitions.

This is the dirtiest part of current `RelayRuntime` and should be extracted early.

### `RelayRuntime`

Target responsibilities:

- bootstrap local runtime lifecycle state,
- shutdown local runtime lifecycle state,
- assign one binding to this runtime,
- release one binding from this runtime,
- expose small read-only runtime views needed by other collaborators.

`RelayRuntime` should not directly own:

- reconnect scheduling internals,
- duplicated binding policy checks,
- snapshot publish queue internals,
- raw agent maps,
- detailed connection-status mutation switch statements.

## Container Design

The runtime container module should move toward direct singleton bindings.

Target binding style:

```ts
bind(DefaultTransportRegistry).toSelf().inSingletonScope();
bind(TransportRegistryToken).toService(DefaultTransportRegistry);

bind(LocalNodeRuntimeStateStore).toSelf().inSingletonScope();
bind(NodeRuntimeStateStoreToken).toService(LocalNodeRuntimeStateStore);

bind(InMemoryRuntimeOwnershipState).toSelf().inSingletonScope();
bind(RuntimeOwnershipStateToken).toService(InMemoryRuntimeOwnershipState);

bind(RuntimeNodeState).toSelf().inSingletonScope();
bind(AgentClientRegistry).toSelf().inSingletonScope();
bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
bind(RuntimeBindingPolicy).toSelf().inSingletonScope();
bind(OpenClawConfigProjector).toSelf().inSingletonScope();
bind(RuntimeSnapshotPublisher).toSelf().inSingletonScope();
bind(RuntimeConnectionStatusHandler).toSelf().inSingletonScope();
bind(RuntimeAgentCatalog).toSelf().inSingletonScope();

bind(RelayRuntime).toSelf().inSingletonScope();
bind(RuntimeClusterStateReader).toSelf().inSingletonScope();
bind(RuntimeBootstrapper).toSelf().inSingletonScope();
```

This is the desired shape, not necessarily the first commit. The migration can introduce these classes incrementally.

## Provider And Factory Rules

### Providers / factories that should be removed first

These abstractions are not buying meaningful flexibility today:

- `createRuntimeOwnershipState`
- `TransportRegistryProvider`
- `RuntimeNodeState` dynamic binding
- `LocalNodeRuntimeStateStore` dynamic binding
- `RuntimeAssignmentCoordinator` dynamic binding

They should be replaced by direct singleton classes first.

### Providers / factories that can remain temporarily

These can remain during migration if initialization order stays awkward:

- `RelayRuntimeAssemblyProvider`
- `PluginHostProvider`
- `ConnectionManagerProvider`
- `buildRuntimeBootstrap`

But they should be kept only if they still solve a real creation problem after the singleton cleanup. If the runtime graph settles into one assembled process-wide instance, these should be collapsed into singleton assembly objects as well.

## Migration Plan

### Phase 1: Singleton boundary cleanup with no behavior change

- Introduce injectable singleton classes for ownership state and the current `toDynamicValue(new ...)` collaborators.
- Keep existing behavior intact.
- Do not change runtime public behavior in this phase.

Expected outcome:

- object lifetime is explicit,
- tests can resolve or replace collaborators consistently,
- runtime module wiring becomes easier to read.

### Phase 2: Extract duplicated binding policy

- Introduce `RuntimeBindingPolicy`.
- Replace duplicated `isRunnableBinding` logic in `RelayRuntime` and `RuntimeAssignmentCoordinator`.

Expected outcome:

- one authoritative runtime rule source,
- lower drift risk during future channel additions.

### Phase 3: Extract `RuntimeSnapshotPublisher`

- Move snapshot queue logic and publish helpers out of `RelayRuntime`.
- Keep `RuntimeNodeState` as lifecycle projection input and ownership state as connection-status source.

Expected outcome:

- `RelayRuntime` loses one side-effect-heavy concern,
- snapshot semantics become independently testable.

### Phase 4: Extract `RuntimeConnectionStatusHandler`

- Move the connection callback switch statement and reconnect scheduling orchestration out of `RelayRuntime`.
- Let the handler depend on ownership state, binding policy, snapshot publisher, and connection orchestration.

Expected outcome:

- `RelayRuntime` stops owning status mutation logic,
- reconnect behavior becomes a dedicated runtime concern.

### Phase 5: Extract `RuntimeAgentCatalog` and `OpenClawConfigProjector`

- Move agent map ownership and client lookup out of `RelayRuntime`.
- Move config rebuilding to a dedicated projector.

Expected outcome:

- `RelayRuntime` becomes a thin facade,
- runtime infrastructure state has dedicated ownership.

### Phase 6: Re-evaluate remaining runtime factories

- Decide whether `RelayRuntimeAssemblyProvider`, `PluginHostProvider`, `ConnectionManagerProvider`, and scheduler bootstrap logic still justify separate factories.
- Collapse them only if their remaining dynamic behavior is incidental rather than essential.

## Error Handling

- Ownership-state operations should stay deterministic and in-memory; errors there should indicate programming mistakes or invalid command order.
- Runtime side-effect collaborators such as snapshot publication and connection restart should isolate external failures and surface them through runtime logging and lifecycle state instead of corrupting ownership state.
- `RuntimeConnectionStatusHandler` should tolerate missing ownership records for stale callbacks by treating them as ignorable runtime races rather than fatal failures.
- `RuntimeBootstrapper` remains the place that translates infrastructure startup failure into a published runtime error snapshot.

## Testing Strategy

### Unit tests

Add or update focused tests for:

- ownership-state restart / stop / unchanged decisions,
- reconnect scheduling and clearing behavior,
- binding runnable policy,
- snapshot publisher queue serialization,
- connection-status handler transitions.

### Container tests

Update container tests to verify:

- singleton resolution for newly class-based runtime collaborators,
- token-to-service bindings for ownership state and runtime state store,
- runtime module can still resolve `RelayRuntime`, `RuntimeBootstrapper`, and `RuntimeClusterStateReader`.

### Regression tests

Preserve existing runtime behavior around:

- binding assignment and refresh,
- disabled or unrunnable binding stop behavior,
- agent client reuse and replacement,
- reconnect after disconnected / error transitions,
- node snapshot publication during bootstrap and shutdown.

## Open Questions

- whether `ConnectionManager` should remain a directly constructed runtime assembly dependency or become a singleton assembly member,
- whether scheduler selection should move from `buildRuntimeBootstrap()` to config-based container binding in the same refactor or in a follow-up,
- whether runtime helpers outside the main path, such as state loaders and routing helpers that still instantiate repositories directly, should be folded into the same DI cleanup or tracked as a separate follow-up.

## Recommended First Execution Slice

The first implementation slice should do exactly three things:

1. convert `RuntimeOwnershipState` into an injectable singleton class,
2. replace `toDynamicValue(new ...)` runtime singletons with class bindings,
3. extract `RuntimeBindingPolicy`.

That slice is small enough to ship safely and large enough to establish the right runtime shape for the later `RelayRuntime` cleanup.
