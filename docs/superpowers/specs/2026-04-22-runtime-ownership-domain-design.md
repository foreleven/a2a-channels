# Runtime Ownership Domain Design

## Context

The current runtime split still leaves the core runtime model scattered across multiple objects:

- [apps/gateway/src/runtime/relay-runtime.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/relay-runtime.ts) owns binding maps, agent maps, reconnect timers, config rebuilding, ownership transitions, and node snapshot publishing.
- [apps/gateway/src/runtime/ownership-state.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/ownership-state.ts) only tracks a narrow status map plus reconnect attempt counts, so it is not the actual runtime domain model.
- [apps/gateway/src/connection-manager.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/connection-manager.ts) mixes connection lifecycle with reply dispatch and still accepts a `listBindings` dependency that is only used by an unused `syncConnections()` path.
- `ChannelBindingEvent` is not consumed by runtime state directly. The real consumers are the schedulers in [apps/gateway/src/runtime/local-scheduler.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/local-scheduler.ts) and [apps/gateway/src/runtime/cluster/leader-scheduler.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/cluster/leader-scheduler.ts), which trigger `RuntimeAssignmentCoordinator.reconcile()`.

The result is a weak domain boundary: local runtime ownership exists conceptually, but its facts and transitions are split between `RelayRuntime`, `RuntimeOwnershipState`, `RuntimeNodeState`, and `ConnectionManager`.

## Goals

- Make `RuntimeOwnershipState` the single in-memory domain model for all bindings assigned to the current runtime instance.
- Remove runtime-state management responsibilities from `RelayRuntime`.
- Remove the `listBindings` dependency from `ConnectionManager`.
- Move connection reply-dispatch ownership closer to runtime infrastructure instead of keeping it as an extra top-level concern in gateway code.
- Keep current scheduler and coordinator roles intact for now. This change is about internal runtime boundaries, not scheduler redesign.

## Non-Goals

- Redesign `ChannelBindingEvent` production or scheduler consumption.
- Replace `RuntimeAssignmentCoordinator` with a command/event-sourced runtime workflow.
- Introduce cluster-wide ownership semantics beyond the current local domain boundary.
- Change the HTTP/API read model structure except where required to consume the new ownership snapshot shape.

## Current Problems

### 1. `RelayRuntime` is not a thin runtime shell

`RelayRuntime` currently owns:

- desired-state caches for bindings and agents,
- local ownership attachment logic,
- connection-status transition logic,
- reconnect timer lifecycle,
- node snapshot publication,
- OpenClaw config rebuilding,
- connection orchestration.

This makes it both the composition root and the local runtime aggregate, which is why the object has become hard to reason about.

### 2. `RuntimeOwnershipState` is too anemic

The current ownership state tracks only:

- presence of an owned binding id,
- last exported connection status,
- reconnect attempt count.

It does not own:

- the assigned binding object,
- refresh/update semantics when a binding changes,
- whether a binding is runnable,
- reconnect timer ownership,
- lifecycle helpers for attach/refresh/detach/restart preparation,
- a complete snapshot of the instance-owned bindings.

That forces `RelayRuntime` to keep parallel maps and coordination logic.

### 3. `ConnectionManager` depends on the wrong abstraction

`ConnectionManager` currently accepts `listBindings` so it can reconcile all enabled bindings through `syncConnections()`. In practice:

- `syncConnections()` has no runtime caller,
- assignment already happens outside the manager,
- connection ownership is per binding, not global.

So `listBindings` is stale architectural baggage.

### 4. Runtime status is projected from split sources

`RuntimeNodeState` currently mirrors binding statuses separately from `RuntimeOwnershipState`, while `RelayRuntime` manually keeps both in sync. That creates avoidable duplication and increases the chance of drift.

## Core Decision

Promote `RuntimeOwnershipState` into the rich domain model for "all bindings currently assigned to this runtime instance", and treat `RelayRuntime` as a thin application-facing facade over that domain plus infrastructure collaborators.

This means:

- `RuntimeOwnershipState` owns the authoritative local assignment set.
- `RuntimeOwnershipState` owns local connection state transitions and reconnect scheduling metadata.
- `RelayRuntime` delegates state mutations to `RuntimeOwnershipState`.
- `ConnectionManager` becomes a pure binding-connection orchestrator with no global desired-state view.
- `RuntimeNodeState` becomes a projection target for publishing node snapshots, not a second ownership model.

## Target Architecture

### `RuntimeOwnershipState`

`RuntimeOwnershipState` becomes the local aggregate-like domain object for owned bindings.

It should own, per binding:

- the latest assigned `ChannelBinding`,
- current runtime connection status,
- agent URL last associated with the active connection,
- last error summary,
- reconnect attempt count,
- reconnect timer handle or equivalent scheduled-retry metadata,
- timestamps needed for runtime snapshot projection.

It should provide domain operations equivalent to:

- `assign(binding)`
- `refresh(binding)`
- `release(bindingId)`
- `has(bindingId)`
- `get(bindingId)`
- `listBindings()`
- `listConnectionStatuses()`
- `markConnecting(bindingId, agentUrl)`
- `markConnected(bindingId, agentUrl)`
- `markDisconnected(bindingId, agentUrl)`
- `markError(bindingId, error, agentUrl)`
- `clearReconnect(bindingId)`
- `scheduleReconnect(bindingId, callback)`
- `toNodeBindingStatuses()`

The exact method names may follow repository conventions, but the ownership domain must fully cover these operations so runtime ownership facts and transitions live in one place.

### `RelayRuntime`

`RelayRuntime` should become a thin facade with these responsibilities:

- hold references to injected collaborators,
- upsert/remove agent clients and rebuild OpenClaw config,
- accept `assignBinding` / `releaseBinding` commands from the coordinator,
- ask `RuntimeOwnershipState` to mutate local runtime state,
- ask `ConnectionManager` to start/stop a specific binding connection,
- publish node snapshots derived from ownership state and lifecycle state.

`RelayRuntime` should not keep:

- `bindingsById`,
- reconnect timer maps,
- ownership-status transition logic,
- duplicate "is this binding owned" bookkeeping.

It may still keep agent lookup maps and generated OpenClaw config, because those are infrastructure assembly concerns rather than runtime ownership facts.

### `ConnectionManager`

`ConnectionManager` should own only:

- creating a connection for one binding,
- starting/restarting/stopping one binding connection,
- handling plugin-host reply dispatch for an inbound message,
- emitting lifecycle callbacks for connection status changes,
- emitting message in/out events.

It should no longer:

- accept `listBindings`,
- reconcile all bindings globally,
- expose `syncConnections()`.

The manager becomes a per-binding connection executor, not a shadow runtime.

### Plugin runtime integration

Reply dispatch ownership should move closer to runtime infrastructure. The practical target is:

- `OpenClawPluginRuntime` still emits/accepts channel reply events,
- `ConnectionManager` is injected into the runtime assembly as the handler for those events,
- the gateway-level runtime shell does not need to understand reply dispatch internals.

This is mostly a boundary clarification, not a behavior change.

### `RuntimeNodeState`

`RuntimeNodeState` should remain a projection builder for node lifecycle snapshots, but it should not be treated as the source of truth for owned bindings.

The snapshot pipeline becomes:

1. `RuntimeOwnershipState` changes.
2. `RelayRuntime` asks ownership state for the current exported binding statuses.
3. `RuntimeNodeState` combines lifecycle metadata plus ownership-provided binding statuses.
4. `NodeRuntimeStateStore` publishes the resulting snapshot.

This keeps only one runtime ownership domain while preserving the current snapshot storage interface.

## Proposed Domain Shape

Each owned binding record must carry information equivalent to:

```ts
interface OwnedBindingRecord {
  binding: ChannelBinding;
  connection: {
    status: RuntimeConnectionStatus["status"];
    agentUrl?: string;
    error?: string;
    updatedAt: string;
  };
  reconnect: {
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
  };
}
```

Any final implementation shape must allow the domain to answer these questions by itself:

- Which bindings are assigned to this runtime?
- What is each binding's latest effective connection state?
- Is there a reconnect already scheduled?
- What should happen when the binding is refreshed, disabled, deleted, connected, disconnected, or errors?

If a question requires reaching back into `RelayRuntime` maps, the domain boundary is still wrong.

## Behavioral Rules

### Assignment

When the coordinator assigns a binding:

1. `RelayRuntime` ensures the target agent exists and updates agent infrastructure if needed.
2. `RuntimeOwnershipState` stores or refreshes the binding as owned.
3. If the binding is disabled or not runnable, ownership remains idle and `ConnectionManager.stopConnection(binding.id)` is called.
4. Otherwise `ConnectionManager.restartConnection(binding)` is called.

### Binding refresh

Refreshing a binding should not require `RelayRuntime` to compare multiple internal maps. The domain should expose whether the effective runtime behavior changed enough to require a restart.

That decision can be represented as a small domain result:

```ts
interface BindingAssignmentDecision {
  shouldRestart: boolean;
  shouldStop: boolean;
}
```

The point is that restart semantics become a domain decision based on old and new owned-binding state.

### Release

When a binding is released:

1. ownership state clears any reconnect timer,
2. ownership state removes the owned record,
3. `RelayRuntime` projects a new node snapshot,
4. `ConnectionManager.stopConnection(bindingId)` is called.

### Connection lifecycle callbacks

When `ConnectionManager` reports `connecting`, `connected`, `disconnected`, or `error`:

1. `RelayRuntime` forwards the callback into `RuntimeOwnershipState`,
2. ownership state mutates the owned record and reconnect metadata,
3. ownership state may request a reconnect action,
4. `RelayRuntime` executes that reconnect action by calling `ConnectionManager.restartConnection(...)` later,
5. node snapshot is republished from the ownership projection.

The transition rules belong to ownership state. Executing external side effects still belongs to runtime/infrastructure.

## Scheduler And Event Consumption

`ChannelBindingEvent` consumption remains unchanged in this design:

- `LocalScheduler` and `LeaderScheduler` subscribe to domain events,
- both schedule `RuntimeAssignmentCoordinator.reconcile()`,
- the coordinator reads desired state and invokes runtime assignment methods,
- the runtime applies those commands using the ownership domain.

This is intentional. Changing event consumers or scheduler topology in the same refactor would expand scope and make the runtime-boundary refactor harder to verify.

## File-Level Changes

### [apps/gateway/src/runtime/ownership-state.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/ownership-state.ts)

Expand from a status map helper into the full local ownership domain:

- store binding objects, not just statuses,
- own reconnect timers or reconnect scheduling metadata,
- expose assignment/update/release decisions,
- export binding-status snapshots for node-state projection.

### [apps/gateway/src/runtime/relay-runtime.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/relay-runtime.ts)

Shrink to:

- agent/client infrastructure coordination,
- OpenClaw config refresh,
- ownership-domain delegation,
- connection-manager invocation,
- node snapshot publication.

Remove:

- `bindingsById`,
- reconnect timer map,
- `ensureOwnershipState`,
- `resetOwnershipStatusToIdle`,
- `scheduleReconnect`,
- `clearReconnectTimer`,
- `applyOwnedConnectionStatus` decision logic that belongs in ownership state.

Some thin translation from ownership-domain results into side effects will still remain.

### [apps/gateway/src/connection-manager.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/connection-manager.ts)

Remove:

- constructor dependency `listBindings`,
- `syncConnections()`.

Keep:

- per-binding lifecycle management,
- message dispatch,
- lifecycle callbacks,
- start/restart/stop helpers.

### [apps/gateway/src/runtime/relay-runtime-assembly-provider.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/relay-runtime-assembly-provider.ts)

Update assembly contracts so connection management is created without `listBindings`, and keep reply-event handling entirely within runtime assembly boundaries.

### [apps/gateway/src/runtime/runtime-node-state.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/runtime/runtime-node-state.ts)

Adjust the API if necessary so node snapshots can be built from externally supplied binding-status lists instead of maintaining a second mutable binding-status map internally.

The preferred end state is that node lifecycle is mutable here, but owned-binding statuses come from `RuntimeOwnershipState`.

## Testing Strategy

The refactor should add or update tests for:

- ownership state attach/refresh/release behavior,
- restart/no-restart decisions when a binding changes,
- reconnect behavior after disconnect/error,
- clearing reconnect timers on release or successful reconnect,
- `ConnectionManager` no longer requiring `listBindings`,
- runtime assignment flows still starting/stopping connections correctly,
- runtime node snapshots reflecting ownership-domain state rather than duplicate runtime maps.

Existing store/runtime tests in [apps/gateway/src/store/store.test.ts](/Users/feng/Projects/agent-relay/apps/gateway/src/store/store.test.ts) are the most likely place to keep coverage first, because this repository already centralizes runtime integration tests there.

## Migration Sequence

Recommended implementation order:

1. Expand `RuntimeOwnershipState` to hold owned binding records and reconnect metadata.
2. Move reconnect scheduling decisions behind ownership state.
3. Refactor `RelayRuntime` to delegate ownership transitions and stop keeping duplicate binding state.
4. Remove `listBindings` and `syncConnections()` from `ConnectionManager`.
5. Simplify node snapshot projection so it consumes ownership-derived statuses.
6. Update tests to prove runtime behavior is unchanged except for the cleaned boundaries.

This order keeps behavior stable while progressively deleting duplicate state.

## Risks

### Duplicate state during migration

While moving logic, there is a temporary risk that `RelayRuntime` and `RuntimeOwnershipState` both still own pieces of reconnect or status state. The implementation must remove the old path quickly rather than leaving both models live.

### Timer lifecycle leaks

If reconnect timers are moved into ownership state, release paths and successful reconnect paths must always clear the prior timer to avoid orphan reconnects against stale bindings.

### Snapshot projection drift

If `RuntimeNodeState` still stores mutable binding statuses after ownership state becomes authoritative, the code can regress into two sources of truth again. The new API should make projection one-way.

## Success Criteria

This design is successful when all of the following are true:

- `RelayRuntime` reads as a thin shell that coordinates collaborators rather than a stateful aggregate.
- `RuntimeOwnershipState` can fully describe every binding currently assigned to the local runtime.
- `ConnectionManager` has no dependency on global binding lists.
- The answer to "who owns local runtime binding state?" is unambiguous: `RuntimeOwnershipState`.
- The answer to "who consumes `ChannelBindingEvent`?" remains unambiguous: the schedulers, not runtime internals.
