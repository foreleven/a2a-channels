# Cluster Connection Sharding

Channel Binding connection ownership is the central distributed-systems problem in the gateway.

A Channel Binding represents desired configuration. A running connection is a side effect. In a multi-instance deployment, exactly one healthy gateway instance should run that side effect for each enabled binding.

## Problem statement

When a user creates or updates a Channel Binding:

1. The configuration must be persisted durably.
2. The change must be visible to all gateway instances.
3. The cluster must decide which instance owns the binding.
4. Only the owner should start the connection.
5. If the owner dies, another instance should take over.
6. If the binding is disabled or deleted, the owner should stop the connection.

## Single-instance behavior

In single-instance mode, there is no distributed ownership decision.

```text
enabled Channel Binding
  -> local instance owns it
  -> RelayRuntime starts connection
```

SQLite and an in-process event bus are enough for this mode.

## Cluster behavior

In cluster mode, every gateway instance can observe the same durable configuration state, but only one instance should execute each connection.

Recommended responsibilities:

```text
Durable DB
  - event store
  - read models
  - aggregate snapshots if needed

Redis
  - instance membership
  - binding ownership leases
  - shard assignment metadata
  - optional pub/sub wakeups

Gateway instance
  - watches/reconciles desired bindings
  - claims assigned leases
  - starts/stops only locally owned connections
```

## Sharding strategy

A simple initial strategy is deterministic hash sharding over active instances:

```text
owner = hash(bindingId) % activeInstanceCount
```

This is easy to understand but can move many bindings when membership changes.

A better production strategy is rendezvous hashing:

```text
owner = maxScore(hash(bindingId, instanceId))
```

Rendezvous hashing minimizes movement when instances join or leave and does not require fixed shard counts.

## Ownership leases

Sharding decides the preferred owner. A Redis lease should enforce the active owner.

Example Redis key:

```text
gateway:binding-owner:{bindingId}
```

Example value:

```json
{
  "instanceId": "gateway-1",
  "leaseToken": "uuid",
  "assignmentVersion": 42,
  "expiresAt": "2026-04-20T12:00:00.000Z"
}
```

Lease rules:

- Owner must renew before expiry.
- Only the current lease token can renew or release.
- If lease expires, another eligible instance may claim it.
- Starting a connection should happen only after lease acquisition succeeds.
- Stopping a connection should happen when lease is lost, binding is disabled/deleted, or assignment changes.

## Event sourcing role

Event sourcing should record durable configuration facts and optionally ownership decisions.

Recommended durable events today:

- `ChannelBindingCreated.v1`
- `ChannelBindingUpdated.v1`
- `ChannelBindingDeleted.v1`
- `AgentRegistered.v1`
- `AgentUpdated.v1`
- `AgentDeleted.v1`

Possible future coordination events:

- `BindingAssignmentChanged.v1`
- `BindingConnectionStarted.v1`
- `BindingConnectionStopped.v1`
- `BindingConnectionFailed.v1`

Be careful with future connection events: connection lifecycle can be noisy. They may belong in an operational log/metrics stream rather than the core configuration event store.

## Reconciliation loop

Each instance should periodically reconcile:

```text
read enabled Channel Bindings
  -> read active cluster membership
  -> compute bindings assigned to this instance
  -> acquire/renew leases for assigned bindings
  -> release/stop bindings no longer assigned
  -> ensure RelayRuntime local connections match owned leases
```

This loop is more important than real-time event delivery. Pub/sub or event notifications can wake the loop early, but reconciliation is the correctness mechanism.

## Failure cases

### Instance dies

- Lease renewal stops.
- Redis lease expires.
- Another instance claims the binding.
- New owner starts the connection.

### Instance loses Redis temporarily

- Instance should stop or avoid starting connections whose leases it cannot renew.
- This prevents split-brain ownership.

### DB event projection lags

- Existing owners continue renewing current leases.
- Reconciliation eventually observes the latest read model.
- Critical updates can trigger explicit wakeups, but correctness should not depend on wakeups.

### Binding is disabled or deleted

- Desired state changes in DB.
- Reconciliation sees the binding should not run.
- Current owner releases lease and stops connection.

## Design rule

The durable DB decides what should exist. Redis decides who currently runs it. `RelayRuntime` only executes what the local instance currently owns.
