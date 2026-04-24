# RelayRuntime DI And Runtime State Design

## Context

`apps/gateway/src/index.ts` has already moved most gateway wiring behind an Inversify container, but runtime bootstrapping still bypasses DI in a few important places:

- `RelayRuntime.load()` is a static factory that constructs transports directly.
- `RelayRuntime` constructs and owns plugin host/runtime, transport registry, agent clients, reconnect timers, ownership state, and connection manager internals.
- HTTP startup is blocked on `await relay.bootstrap()`.
- Runtime status is exposed as a local in-memory view, while the target design needs cluster-aware node and binding status aggregated from DB plus Redis or local memory.

The result is that `RelayRuntime` currently mixes aggregate state, infrastructure assembly, orchestration, and cluster concerns in one object.

## Goals

- Make `RelayRuntime` injectable and remove `RelayRuntime.load()`.
- Change runtime startup so HTTP can start before runtime bootstrap completes.
- Model `RelayRuntime` as a local runtime aggregate root that only manages its own node state.
- Keep global truth out of runtime memory. APIs should aggregate DB state with Redis or single-process runtime state.
- Move all `RelayRuntime` dependencies behind injectable classes or interfaces.
- Create a cluster-ready read model that can show node state in Web, while still working in single-instance mode.

## Non-Goals

- Rebuild the whole domain event model.
- Introduce a global in-memory snapshot of bindings or agents.
- Complete full leader-election behavior in this change. The design keeps the scheduler boundary ready for that, but focuses first on structure and state ownership.

## Core Decisions

### 1. Two Aggregates, Two Kinds Of Truth

There are two separate concerns and they should not share one aggregate:

- Global desired state: bindings, agents, and node registration metadata. This lives in DB and is queried directly by APIs and runtime coordination code.
- Local runtime state: this node's bootstrap state, scheduler role, owned bindings, and live connection statuses. This belongs to `RelayRuntime`.

`RelayRuntime` does not own a global bindings/agents cache. Global views are always composed from DB plus Redis or local memory state.

### 2. Runtime APIs Are Read Models, Not Aggregate Internals

Runtime HTTP endpoints should not be thin wrappers around `RelayRuntime` internals. They should go through a dedicated read-model service that merges:

- DB records for bindings, agents, and runtime nodes.
- Redis runtime state in cluster mode.
- Local in-memory runtime state in single-instance mode.

This keeps the runtime aggregate small and gives Web one stable query surface for both single-node and clustered deployments.

### 3. Bootstrap Must Be Asynchronous Relative To HTTP

Gateway startup becomes two-stage:

1. Build container, initialize stores, seed defaults, start outbox worker, build HTTP app, and start `serve()`.
2. Resolve a runtime bootstrap coordinator from DI and start it in the background.

If runtime bootstrap fails, the process keeps serving HTTP and exposes the node as `error` through runtime status APIs.

## Target Architecture

### RelayRuntime

`RelayRuntime` becomes an injectable local aggregate root with these responsibilities:

- Track local node lifecycle: `created`, `bootstrapping`, `ready`, `stopping`, `stopped`, `error`.
- Track owned bindings for this node.
- Track local connection statuses for owned bindings.
- Accept assignment commands from a coordinator.
- Update local aggregate state based on connection events.
- Publish local runtime snapshots to an injected state sink.
- Expose read-only local snapshots.

`RelayRuntime` does not:

- query DB,
- query Redis,
- choose scheduler type,
- register plugins directly,
- construct transports or agent clients directly,
- aggregate cluster-wide state.

### RuntimeBootstrapper

`RuntimeBootstrapper` is an injectable coordinator responsible for background startup and shutdown of runtime-related services.

Responsibilities:

- Set the local runtime aggregate to `bootstrapping`.
- Start runtime infrastructure in dependency order.
- Start scheduler/coordinator loops.
- Mark the local node `ready` on success or `error` on failure.
- Provide a single `bootstrap(): Promise<void>` and `shutdown(): Promise<void>` boundary for `index.ts`.

The gateway entrypoint should call `void runtimeBootstrapper.bootstrap()` after HTTP server startup and should not await it before listening.

### RuntimeAssignmentCoordinator

`RuntimeAssignmentCoordinator` is a coordinator service, not an aggregate.

Responsibilities:

- React to domain events and periodic reconcile ticks.
- Read current bindings and agents from DB through injected query services.
- Read current runtime ownership data through an injected runtime state reader.
- Decide which bindings this node should own.
- Call `RelayRuntime.applyAssignment(...)` and `RelayRuntime.releaseAssignment(...)`.

It does not hold a long-lived global in-memory snapshot. Each reconcile pass is built from current storage-backed data.

### RuntimeClusterStateReader

`RuntimeClusterStateReader` is the only service used by runtime HTTP query endpoints.

Responsibilities:

- Read bindings, agents, and node metadata from DB.
- Read live runtime status from Redis in cluster mode.
- Read live runtime status from local snapshot providers in single-instance mode.
- Return stable DTOs for Web, including node lists, ownership, connection states, scheduler role, heartbeat information, and recent errors.

### NodeRuntimeStateStore

`NodeRuntimeStateStore` abstracts where live runtime state is written and read.

Interface shape:

- `publishNodeSnapshot(snapshot)`
- `publishBindingStatus(status)`
- `clearBindingStatus(bindingId)`
- `listNodeSnapshots()`
- `listBindingStatuses()`

Implementations:

- `LocalNodeRuntimeStateStore`: single-instance, backed by current-process memory.
- `RedisNodeRuntimeStateStore`: cluster mode, backed by Redis.

DB remains the primary source for configuration and node registration metadata, not for high-frequency connection transitions.

### Injectable Infrastructure Boundaries

The following classes should become injectable or should be hidden behind injectable factories/providers:

- `RelayRuntime`
- `RuntimeBootstrapper`
- `RuntimeAssignmentCoordinator`
- `RuntimeClusterStateReader`
- `NodeRuntimeStateStore`
- `ConnectionManager` or a renamed `RuntimeConnectionOrchestrator`
- `AgentClientRegistry`
- `PluginHostProvider`
- `TransportRegistryProvider`
- `LocalScheduler`
- `LeaderScheduler`

`registerAllPlugins()` should move behind `PluginHostProvider` so runtime assembly is no longer done manually in the aggregate.

## RelayRuntime Internal Shape

`RelayRuntime` should shrink toward this interface:

```ts
interface RelayRuntime {
  bootstrap(): Promise<void>;
  shutdown(): Promise<void>;
  applyAssignment(assignment: RuntimeBindingAssignment): Promise<void>;
  releaseAssignment(bindingId: string): Promise<void>;
  snapshot(): LocalRuntimeSnapshot;
}
```

Recommended internal collaborators:

- `RuntimeNodeState`: pure state holder for lifecycle, owned bindings, and connection statuses.
- `RuntimeConnectionOrchestrator`: manages actual binding connection start/stop/restart mechanics.
- `AgentClientRegistry`: manages agent client creation, reuse, and lifecycle.
- `NodeRuntimeStateStore`: receives published snapshots after local state changes.

Connection and lifecycle callbacks should be translated into aggregate mutations first, then published through `NodeRuntimeStateStore`.

## Startup Sequence

The runtime startup sequence should be:

1. Build container.
2. Initialize DB and seed defaults.
3. Start outbox worker.
4. Build HTTP app and start listening.
5. Resolve `RuntimeBootstrapper`.
6. Trigger `runtimeBootstrapper.bootstrap()` in the background.
7. During bootstrap:
   - initialize runtime internals,
   - upsert local node registration metadata in DB,
   - publish `bootstrapping` node state,
   - start scheduler/coordinator,
   - publish `ready` state.
8. On failure:
   - publish `error` state with timestamp and error summary,
   - keep HTTP alive.

Shutdown sequence should reverse this order:

1. Stop scheduler/coordinator.
2. Shutdown `RelayRuntime`.
3. Stop outbox worker.
4. Close HTTP server.

## State Model

### DB-Owned State

DB remains the source of truth for:

- agent configuration,
- channel binding configuration,
- runtime node registration metadata.

Runtime node registration metadata should include at least:

- `nodeId`,
- `displayName`,
- `mode` (`single` or `cluster`),
- `registeredAt`,
- `lastKnownAddress`.

### Redis Or Local Runtime State

Live runtime state should include:

- node lifecycle state,
- scheduler role,
- heartbeat time,
- owned binding ids,
- per-binding connection status,
- recent error summary,
- agent URL currently associated with the binding connection.

Cluster mode stores this in Redis. Single-instance mode keeps it in local memory and exposes it through the same read interface.

### API Projection

`RuntimeClusterStateReader` should project:

- `/api/runtime/nodes`
  Returns node-level status, role, heartbeat, last error, and owned binding counts.
- `/api/runtime/connections`
  Returns binding-level connection state with binding metadata from DB plus runtime ownership/live status.
- `/api/runtime/overview`
  Returns a compact combined snapshot for the Web dashboard. This endpoint is part of phase 4, not a phase 1 requirement.

These endpoints should have the same shape in single-instance and cluster modes. The difference is only the backing runtime state source.

## Event Flow

The steady-state runtime flow is:

1. API command updates DB-backed binding or agent data.
2. Application service emits a domain event.
3. `RuntimeAssignmentCoordinator` reacts immediately or on the next debounce tick.
4. Coordinator reads the latest DB configuration and current ownership state.
5. Coordinator decides the local node's assignments.
6. Coordinator calls `RelayRuntime.applyAssignment(...)` or `releaseAssignment(...)`.
7. `RelayRuntime` drives connection actions through `RuntimeConnectionOrchestrator`.
8. Connection callbacks mutate local runtime state.
9. Local runtime state is published through `NodeRuntimeStateStore`.
10. Runtime query APIs read DB plus runtime state store and return the aggregated view.

This design keeps commands, coordination, runtime execution, and query projection separate.

## Migration Plan

The implementation should be phased to reduce breakage:

### Phase 1. Introduce injectable runtime assembly

- Bind `RelayRuntime` and its collaborators in the container.
- Remove `RelayRuntime.load()`.
- Add `RuntimeBootstrapper`.
- Move plugin registration and transport assembly behind providers.

### Phase 2. Split local runtime state from query state

- Introduce `RuntimeNodeState` and `NodeRuntimeStateStore`.
- Change `RelayRuntime` to publish snapshots instead of serving as the global runtime API source.
- Add `RuntimeClusterStateReader`.

### Phase 3. Move assignment logic out of runtime

- Add `RuntimeAssignmentCoordinator`.
- Make schedulers trigger coordination instead of directly owning state logic.
- Remove DB snapshot loading from runtime-related classes that should not read storage directly.

### Phase 4. Expand runtime APIs for Web cluster view

- Add node-level endpoints.
- Change connection endpoints to use `RuntimeClusterStateReader`.
- Keep single-instance mode returning the same DTOs with only one node.

## Testing Strategy

Tests should be redistributed away from large `RelayRuntime` harnesses.

### RelayRuntime aggregate tests

Cover:

- bootstrap lifecycle transitions,
- assignment apply/release behavior,
- connection status transitions,
- snapshot publication,
- shutdown behavior.

These tests should use fakes for orchestrator, state store, plugin provider, and client registry.

### Coordinator tests

Cover:

- desired-state reconcile from DB data,
- ownership-aware assignment decisions,
- detach behavior when bindings are disabled or agents disappear,
- periodic repair when runtime state diverges from DB state.

### Query projection tests

Cover:

- DB plus Redis aggregation,
- DB plus local-memory aggregation,
- node and connection DTO shape stability,
- stale heartbeat and error rendering.

### HTTP integration tests

Cover:

- HTTP server starts before runtime bootstrap finishes,
- runtime endpoints return `bootstrapping`, `ready`, and `error` states,
- existing channel and agent APIs remain unchanged.

## Risks And Guardrails

- `RuntimeAssignmentCoordinator` can become a new god object if it owns storage, policy, and scheduling. Keep it limited to reconcile orchestration and decision execution.
- `RuntimeClusterStateReader` must remain a query service. It should not mutate runtime state.
- `RelayRuntime` must not reintroduce global configuration caches. If data is not local runtime state, it should be read from DB or injected state readers per reconcile pass.
- Redis state should remain ephemeral. Long-term configuration and registration metadata belong in DB.

## Acceptance Criteria

- `apps/gateway/src/index.ts` no longer calls `RelayRuntime.load()`.
- `RelayRuntime` is constructed by DI and depends only on injected collaborators.
- Gateway HTTP startup no longer waits for runtime bootstrap completion.
- Runtime status APIs read from a dedicated query service, not directly from aggregate internals.
- Single-instance mode exposes local runtime state through the same API shape used by cluster mode.
- Runtime logic is split so `RelayRuntime` only owns local runtime aggregate state and assignment execution, not global configuration queries.
