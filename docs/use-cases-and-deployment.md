# Use Cases and Deployment Model

This project is not primarily optimizing for high-frequency configuration writes. The key architectural problem is turning low-frequency configuration changes into reliable runtime connection ownership, including in a multi-instance gateway cluster.

## Core use cases

### 1. Configure an Agent

Users register or update an Agent endpoint.

Characteristics:

- Low frequency
- Mostly metadata/configuration
- Does not directly create a long-lived channel connection
- Affects routing from channel messages to the target agent transport

Expected flow:

```text
Admin/API
  -> Agent application service
  -> Agent aggregate
  -> Agent event stream
  -> Agent read model
  -> Runtime agent-client state refresh/reconciliation
```

Agent changes are important, but they are not the main reason to introduce event sourcing.

### 2. Configure a Channel Binding

Users bind a channel account, such as a Feishu/Lark bot account, to an Agent config by `agentId`. The runtime resolves the Agent URL from that config.

Characteristics:

- Low frequency compared with message traffic
- Creates or updates desired runtime state
- May require a long-lived connection/monitor to be started
- In cluster mode, exactly one gateway instance should own the active connection for a binding

Expected flow:

```text
Admin/API
  -> ChannelBinding application service
  -> ChannelBinding aggregate
  -> ChannelBinding event stream
  -> ChannelBinding read model
  -> Connection assignment/sharding
  -> Owning gateway instance starts or restarts the connection
```

This is the main reason event sourcing is useful in the project: a binding change is not just a row update; it is a durable fact that should drive distributed runtime coordination.

## Deployment modes

### Single-instance mode

Single-instance mode is intended for local development and small deployments.

Recommended dependencies:

- SQLite
- in-process event bus
- in-process `RelayRuntime`

Behavior:

```text
SQLite events/read models
  -> local projection catch-up
  -> local runtime reconciliation
  -> same process owns all enabled bindings
```

In this mode, sharding degenerates to a single owner: the local process.

### Cluster mode

Cluster mode is intended for production deployments with multiple gateway instances.

Recommended dependencies:

- Durable DB: MySQL, PostgreSQL, or another production DB
- Redis for distributed coordination
- Multiple gateway instances

Behavior:

```text
Durable DB events/read models
  -> distributed subscription/reconciliation
  -> Redis-backed ownership/sharding
  -> one gateway instance owns each enabled Channel Binding connection
```

Redis should not replace the durable event store. It should coordinate ephemeral runtime ownership, leases, membership, and rebalance decisions.

## Why event sourcing fits this project

Event sourcing provides a durable log of configuration facts:

- Agent registered/updated/deleted
- Channel Binding created/updated/deleted
- Future ownership/rebalance events if modeled explicitly

For this project, event sourcing is valuable because it allows runtime processes to answer:

- What configuration changes happened while this instance was down?
- Which bindings should exist now?
- Which runtime side effects need to be reconciled?
- What changed before a connection was restarted or moved?

It is not mainly about write throughput. It is about reliable reconstruction and coordination of desired runtime state.

## Ownership model for Channel Binding connections

A Channel Binding should have a desired state and an owner state.

### Desired state

Stored durably in the primary DB and derived from events:

```text
binding id
channel type
account id
channel config
agent id
enabled flag
```

### Owner state

Stored ephemerally in Redis in cluster mode:

```text
binding id
owner instance id
lease token
lease expiry
assignment version
```

The desired state answers: should this binding run?

The owner state answers: which live instance is responsible for running it right now?

## Recommended bounded contexts/components

```text
Configuration write model
  - Agent aggregate
  - ChannelBinding aggregate
  - event store

Read models
  - agents projection
  - channel_bindings projection

Runtime coordination
  - cluster membership
  - binding assignment/sharding
  - ownership lease renewal
  - rebalance on membership or binding changes

Runtime execution
  - RelayRuntime
  - ConnectionManager
  - OpenClaw runtime/plugin host
  - Agent clients
```

## Design principle

`RelayRuntime` should not decide global ownership by itself. It should execute the subset of bindings assigned to the current instance.

A separate assignment/sharding component should decide ownership, and `RelayRuntime` should reconcile local connections against that assignment.
