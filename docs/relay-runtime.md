# RelayRuntime Runtime Model

`RelayRuntime` is the local executor that turns persisted desired state into live channel and agent side effects.

It is not the domain model, not the global ownership selector, and not the place where cluster coordination should live.

## Phase 1

Current code implements **Phase 1: single-instance convergence**.

The runtime model in this phase is:

- `RelayRuntime` owns a local `RuntimeOwnershipState`.
- `RuntimeOwnershipState` tracks owned bindings plus observable connection status:
  `idle`, `connecting`, `connected`, `disconnected`, `error`.
- `ConnectionManager` performs channel side effects only:
  start, stop, restart, dispatch inbound messages, and emit connection lifecycle callbacks.
- `RelayRuntime` applies reconnect policy decisions and schedules local backoff repair when a binding becomes `disconnected` or `error`.
- `LocalScheduler` wakes reconciliation from persisted snapshots and repairs only bindings that are missing locally or have lost their local connection.

In other words, Phase 1 separates three questions:

```text
What should exist?   -> DB state tables + outbox-fed snapshots
What is healthy?     -> RuntimeOwnershipState + connection callbacks
How is it repaired?  -> RelayRuntime reconnect policy + LocalScheduler reconcile
```

## Phase 1 Responsibilities

`RelayRuntime` currently owns or coordinates:

- OpenClaw plugin runtime and plugin host bootstrapping
- in-memory binding and agent indexes
- agent client lifecycle
- OpenClaw-compatible config generation
- binding attach / refresh / detach semantics
- local connection status transitions through `RuntimeOwnershipState`
- reconnect timer scheduling for local repair

`RelayRuntime` should not:

- infer global ownership from domain events
- embed Redis lease logic
- treat live event delivery as the source of truth
- let callers manipulate `ConnectionManager` directly as a source of business truth

## Current Lifecycle

### Bootstrap

```text
loadRuntimeStateSnapshot()
  -> read bindings + agents from state tables
  -> new RelayRuntime(...)
  -> bootstrap plugins
  -> LocalScheduler reconcile
  -> attach/refresh locally runnable bindings
```

### Incremental Repair

```text
domain event / timer wakeup
  -> LocalScheduler reconcile
  -> compare desired bindings with local runtime state
  -> refresh missing or unhealthy bindings
  -> detach bindings that no longer belong locally
```

### Connection Status

```text
ConnectionManager callback
  -> RelayRuntime
  -> RuntimeOwnershipState transition
  -> optional reconnect scheduling
```

Healthy bindings move through:

```text
idle -> connecting -> connected
```

Failure paths move through:

```text
connected -> disconnected -> reconnect backoff -> connecting
connected -> error -> reconnect backoff -> connecting
```

## Desired-State Invariants

Phase 1 also relies on persistence-level constraints to keep desired state convergent:

- `channel_bindings.agent_id` must reference an existing `agents.id`
- `channel_bindings.enabled_key` enforces at most one enabled binding for a given `channel_type + account_id`

Those constraints are intentionally outside `RelayRuntime`; runtime consumes the already-validated desired state.

## Phase 2

**Phase 2 is not implemented yet.**

Planned cluster extensions are:

- ownership gate abstraction
- Redis-backed binding leases
- leader / scheduler coordination
- rebalance and failover behavior
- optional cross-instance publication of operational state

When Phase 2 lands, `RelayRuntime` should remain the local executor only.
Cluster code should decide which bindings are owned locally before handing them to runtime.
