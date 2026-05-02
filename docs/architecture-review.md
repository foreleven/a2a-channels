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
- Current-state repositories in `apps/gateway/src/infra/`
- Runtime orchestration in `apps/gateway/src/runtime/relay-runtime.ts`
- SQLite persistence via Prisma tables: `channel_bindings`, `agents`, `runtime_nodes`

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
    channel-binding-repo.ts
    agent-config-repo.ts
  runtime/
```

The pure domain should remain in `packages/domain/src/`: aggregates, events, value objects, repository ports, and domain invariants.

### 2. Runtime changes are observed by periodic reconciliation

The outbox / `DomainEventBus` fast-path has been removed. Repositories write current state, and `LocalScheduler` reconciles from repository state on startup and interval ticks.

This has two consequences:

1. A command can succeed before runtime connections reflect the new desired state.
2. Runtime recovery is independent of missed in-process events.

Recommended next step:

- Make the scheduler interval explicit in config if change latency matters.
- Add an explicit notification/outbox mechanism only if runtime side effect latency becomes critical.

### 3. Cross-aggregate constraints read from state tables

`ChannelBindingService.assertNoDuplicateEnabled()` checks duplicate enabled bindings through `repo.findEnabled()`, which reads the `channel_bindings` projection table.

That can be acceptable in a single-process local gateway. For stronger multi-writer safety, it should be backed by database constraints or a dedicated consistency model.

Recommended options:

- Add a DB-level unique constraint or consistency table for enabled `(channelType, accountId)` bindings.
- Model the uniqueness constraint as a separate aggregate if this becomes a distributed/multi-writer system.
- Keep the current approach only if the architecture explicitly accepts single-process eventual consistency.

### 4. Runtime ownership is not yet separated from runtime execution

A Channel Binding is durable desired state. A running channel connection is a local side effect. In cluster mode, the system needs a separate ownership layer so exactly one healthy gateway instance runs each enabled binding.

The current `RelayRuntime` delegates ownership decisions to scheduler/coordinator boundaries. Cluster mode still needs a complete ownership layer so exactly one healthy gateway instance runs each enabled binding.

Recommended target:

```text
state tables
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
