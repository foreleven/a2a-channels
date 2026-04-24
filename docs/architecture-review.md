# DDD and Event Sourcing Architecture Review

This document reviews the current DDD + event sourcing refactor and records the main implementation issues to address before the architecture becomes the stable baseline.

The core use case is not high-frequency configuration writes. Agent and Channel Binding configuration are low-frequency operations. Event sourcing is useful here because a durable Channel Binding change must be reconstructable and must reliably drive runtime connection ownership, including in a multi-instance gateway cluster.

## Current shape

The gateway currently has these main pieces:

- Domain model in `packages/domain/src/`:
  - aggregates: `ChannelBindingAggregate`, `AgentConfigAggregate`
  - events: `ChannelBindingCreated.v1`, `AgentRegistered.v1`, etc.
  - repository interfaces
- Gateway application wiring in `apps/gateway/src/index.ts`
- Application services in `apps/gateway/src/application/`
- Event-sourced repositories and in-process event bus in `apps/gateway/src/infra/`
- Read-model projections in `apps/gateway/src/projections/`
- Runtime orchestration in `apps/gateway/src/runtime/relay-runtime.ts`
- SQLite persistence via Prisma tables: `events`, `channel_bindings`, `agents`, `projection_checkpoints`

The architecture is close to CQRS/event sourcing, but several boundaries are currently blurred. The most important boundary is between persisted desired state and runtime ownership: the database says which Channel Bindings should exist, while single-instance local ownership or cluster Redis leases decide which gateway instance runs each connection.

## Main issues

### 1. Application services were moved out of `domain`

`apps/gateway/src/application/channel-binding-service.ts` and `apps/gateway/src/application/agent-service.ts` coordinate use cases:

- generate IDs
- load aggregates from repositories
- check cross-aggregate/application-level constraints
- save aggregates
- expose query methods

These responsibilities belong to an application layer, not the domain layer. The code now reflects that placement.

Recommended structure:

```text
apps/gateway/src/
  application/
    channel-binding-service.ts
    agent-service.ts
  infra/
    domain-event-bus.ts
    channel-binding-repo.ts
    agent-config-repo.ts
    prisma-event-store.ts
  projections/
  runtime/
```

The pure domain should remain in `packages/domain/src/`: aggregates, events, value objects, repository ports, and domain invariants.

### 2. The current event bus gives weak delivery guarantees

`DomainEventBus` wraps `EventEmitter` and publishes events synchronously by event type. Repositories append events to the database and then publish them in process.

This has two consequences:

1. A command can successfully append events even if projection handlers later fail.
2. `RelayRuntime` side effects can fail after the HTTP request has already succeeded.

The projections catch up from the event store on restart, but `RelayRuntime` side effects are not checkpointed. If a runtime event handler fails, the process only logs the error and may keep running with stale in-memory state or stale connections.

Recommended next step:

- Treat the current bus as a best-effort in-process notification bus.
- Make persisted `events` the source of truth.
- Add an explicit subscription/reconciliation mechanism for runtime side effects.
- Prefer a durable outbox/subscription worker if the runtime side effects become critical.

### 3. Projection checkpointing is not transactional per event

`ChannelBindingProjection.catchUp()` and `AgentConfigProjection.catchUp()` replay events and update the checkpoint after a batch. If the process crashes midway, already-applied events may be replayed.

The current handlers are mostly idempotent because they use `upsert`, `updateMany`, and `deleteMany`, but this is an implementation detail. The projection contract should make idempotency explicit.

Recommended options:

- Apply one event and update the projection checkpoint in the same DB transaction.
- Keep handlers idempotent and document that replay is at-least-once.
- Add tests that replay each event twice and assert the read model remains correct.

### 4. Cross-aggregate constraints read from projection tables

`ChannelBindingService.assertNoDuplicateEnabled()` checks duplicate enabled bindings through `repo.findEnabled()`, which reads the `channel_bindings` projection table.

That can be acceptable in a single-process local gateway, but it is not a strong event-sourcing invariant. If the projection lags, the command side can make decisions from stale state.

Recommended options:

- Add a DB-level unique constraint or consistency table for enabled `(channelType, accountId)` bindings.
- Model the uniqueness constraint as a separate aggregate if this becomes a distributed/multi-writer system.
- Keep the current approach only if the architecture explicitly accepts single-process eventual consistency.

### 5. Query projections are being treated like snapshots

The `channel_bindings` and `agents` tables are read models. They are not aggregate snapshots.

Repositories still rebuild aggregates by replaying all events for a stream. That is correct for small streams but becomes expensive as streams grow.

A separate aggregate snapshot mechanism is needed. See `snapshot-strategy.md`.

### 6. Runtime ownership is not yet separated from runtime execution

A Channel Binding is durable desired state. A running channel connection is a local side effect. In cluster mode, the system needs a separate ownership layer so exactly one healthy gateway instance runs each enabled binding.

The current `RelayRuntime` directly reacts to domain events and starts/stops local resources. That is acceptable as a single-instance fast path, but it should not be the correctness mechanism for cluster mode.

Recommended target:

```text
events/read models
  -> desired Channel Binding state
  -> assignment/sharding component
  -> Redis ownership lease in cluster mode
  -> local RelayRuntime executes only owned bindings
```

Implications:

- In single-instance mode, ownership degenerates to "this process owns all enabled runnable bindings".
- In cluster mode, Redis should coordinate membership, leases, renewal, release, and rebalance.
- Domain events and pub/sub notifications should wake reconciliation, not directly imply local ownership.
- `RelayRuntime` should reconcile local connections against the locally owned binding set.

See `use-cases-and-deployment.md`, `event-flow.md`, `cluster-connection-sharding.md`, and `relay-runtime.md` for the target flow.

## Recommended refactor order

1. Application services have been moved out of `apps/gateway/src/domain/`.
2. The EventEmitter-based bus has been relocated as infrastructure.
3. Document the event delivery model as at-least-once for projections and best-effort for runtime side effects.
4. Add aggregate snapshot tables and repository snapshot loading.
5. Introduce a runtime reconciliation loop so `RelayRuntime` can recover from missed or failed event handling.
6. Add single-instance ownership filtering as the local baseline.
7. Add Redis-backed membership, assignment, and ownership leases for cluster mode.