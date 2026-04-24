# Event Flow

This document describes how commands, domain events, projections, connection assignment, and `RelayRuntime` should work together.

The important use case is not high-frequency configuration writes. Agent and Channel Binding configuration are relatively low frequency. The critical requirement is that a persisted Channel Binding change reliably drives connection ownership and startup, including in a multi-instance gateway cluster.

## Command path

The write path is:

```text
HTTP route
  -> application service
  -> aggregate method
  -> pending domain events
  -> event-sourced repository
  -> events table
  -> in-process event bus
```

Example for channel bindings:

```text
POST /api/channels
  -> ChannelBindingService.create()
  -> ChannelBindingAggregate.create()
  -> ChannelBindingCreated.v1
  -> EventSourcedChannelBindingRepository.save()
  -> PrismaEventStore.append()
  -> DomainEventBus.publish()
```

The event store is the durable source of truth for write-side state.

## Projection path

Read-model projections subscribe to the in-process bus while the gateway is running:

```text
DomainEventBus
  -> ChannelBindingProjection
  -> channel_bindings table

DomainEventBus
  -> AgentConfigProjection
  -> agents table
```

On startup, projections call `catchUp()` and replay events from the `events` table after their last checkpoint:

```text
events table
  -> projection.catchUp()
  -> read-model table
  -> projection_checkpoints
```

This means read models are derived data. If they are lost or stale, they should be rebuildable from events.

## Runtime and assignment path

`RelayRuntime` should use read-model state plus local ownership assignment during bootstrap:

```text
channel_bindings table + agents table
  -> load desired runtime state
  -> assignment/sharding component decides local ownership
  -> RelayRuntime.load()
  -> RelayRuntime.bootstrap()
  -> OpenClaw plugin host
  -> ConnectionManager.syncConnections() for locally owned bindings
```

In the current single-instance implementation, local ownership is implicit: the only process owns all enabled runnable bindings.

After bootstrap, event notifications may wake runtime reconciliation:

```text
DomainEventBus or distributed notification
  -> runtime reconciliation wakeup
  -> reload desired bindings/agents
  -> compute locally owned bindings
  -> acquire/renew/release ownership if needed
  -> ConnectionManager restart/stop local connections
  -> AgentClient start/stop
```

The current implementation directly subscribes `RelayRuntime` to domain events and mutates in-memory state. In cluster mode, that should become an optimization, not the correctness mechanism.

This makes `RelayRuntime` a local runtime executor. It should not be the component that decides global cluster ownership.

## Important consistency boundaries

### Events are durable

Once `PrismaEventStore.append()` succeeds, the event is durable in the `events` table.

### Bus delivery is best effort

`DomainEventBus` is an in-process `EventEmitter`. It does not provide durable delivery, retries, ordering across processes, dead-letter handling, or handler checkpointing.

Projection catch-up compensates for missed projection events after restart.

Runtime side effects do not currently have the same durable catch-up mechanism. In the target cluster architecture, correctness should come from a reconciliation loop that compares durable desired state with Redis ownership and local runtime state.

### Read models are eventually consistent

`channel_bindings` and `agents` are projections. Commands that query them should be understood as reading eventually consistent data unless the projection update is made transactional with command handling.

## Recommended target mechanism

For the current single-instance gateway, a practical target is:

```text
Command
  -> append events transactionally
  -> publish best-effort in-process notification
  -> projections consume at-least-once with idempotent handlers
  -> runtime reconciles periodically from read models
```

For cluster mode:

```text
Command
  -> append events transactionally
  -> update/read projections
  -> distributed notification wakes instances
  -> instances reconcile desired bindings with cluster membership
  -> Redis ownership lease determines the single active owner
  -> owning RelayRuntime starts/stops the connection
```

For a stronger production-grade design:

```text
Command
  -> append events + outbox record in one transaction
  -> subscription worker reads durable event stream/outbox
  -> projection subscription checkpoint per handler
  -> runtime subscription checkpoint or reconciliation job
  -> retries + dead-letter for failed side effects
```
