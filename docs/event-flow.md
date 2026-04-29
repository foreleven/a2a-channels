# Event Flow

This document describes how commands, domain events, connection assignment, and `RelayRuntime` fit together after the outbox fast-path removal.

The important use case is not high-frequency configuration writes. Agent and Channel Binding configuration are relatively low frequency. The critical requirement is that a persisted Channel Binding change reliably drives connection ownership and startup, including in a multi-instance gateway cluster.

## Command path

The write path is:

```text
HTTP route
  -> application service
  -> aggregate method
  -> pending domain events
  -> state repository
  -> state table
```

Example for channel bindings:

```text
POST /api/channels
  -> ChannelBindingService.create()
  -> ChannelBindingAggregate.create()
  -> ChannelBindingCreated.v1
  -> ChannelBindingStateRepository.save()
  -> channel_bindings table
```

The state tables are the durable source of truth for configuration.

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

After bootstrap, scheduler ticks wake runtime reconciliation:

```text
LocalScheduler startup / interval tick
  -> reload desired bindings/agents
  -> compute locally owned bindings
  -> acquire/renew/release ownership if needed
  -> ConnectionManager restart/stop local connections
  -> AgentClient start/stop
```

This makes `RelayRuntime` a local runtime executor. It should not be the component that decides global cluster ownership.

## Important consistency boundaries

### State tables are durable

`channel_bindings` and `agents` are current-state tables. Runtime correctness comes from a reconciliation loop that compares durable desired state with ownership and local runtime state.

## Recommended target mechanism

For the current single-instance gateway, a practical target is:

```text
Command
  -> update state transactionally
  -> runtime reconciles periodically from state tables
```

For cluster mode:

```text
Command
  -> update state transactionally
  -> optional distributed notification wakes instances
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
