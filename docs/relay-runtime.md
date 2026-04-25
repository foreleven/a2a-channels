# RelayRuntime Runtime Model

`RelayRuntime` is now the runtime lifecycle and relay wiring boundary for the
gateway process.

It is not the desired-state owner selector, and it does not decide which
bindings should run. Those decisions live below the scheduler / assignment
boundary:

```text
RuntimeScheduler
  -> RuntimeAssignmentCoordinator
  -> RuntimeCommandHandler
  -> RuntimeAssignmentService
  -> RuntimeOwnershipState + ConnectionManager
```

## Current Role

`RelayRuntime` coordinates process-local runtime startup and shutdown:

- register/update this runtime node through `RuntimeNodeStateRepository`
- publish bootstrapping / ready / stopping / stopped snapshots
- assemble `OpenClawPluginRuntime` and `OpenClawPluginHost`
- initialize `ConnectionManager` with plugin host, agent client resolver, and callbacks
- start/stop `DomainEventBridge`
- start/stop `RuntimeScheduler`
- clean up partially-started runtime pieces if bootstrap fails
- publish an error snapshot when bootstrap fails

It also wires connection lifecycle callbacks back into
`RuntimeAssignmentService`, which owns status transitions and reconnect
scheduling.

## Startup Flow

Startup is synchronous from `GatewayServer`'s point of view. The server waits
for `RelayRuntime.bootstrap()` before opening the HTTP listener.

```text
GatewayServer.start()
  -> OutboxWorker.start()
  -> RelayRuntime.bootstrap()
       -> RuntimeNodeStateRepository.upsert(node metadata)
       -> DomainEventBridge.start(nodeId)
       -> RuntimeScheduler.start()
  -> Hono listen
```

`RelayRuntime.bootstrap()` does not eagerly load all bindings or create all
connections. Binding recovery is driven by the scheduler's reconciliation path.

## Binding Convergence Flow

Bindings are attached, refreshed, or detached through the assignment boundary:

```text
Domain event / startup wakeup
  -> RuntimeEventBus
  -> LocalScheduler
  -> RuntimeAssignmentCoordinator.reconcile()
  -> RuntimeCommandHandler.handle(command)
  -> RuntimeAssignmentService.assignBinding()/releaseBinding()
  -> ConnectionManager.restartConnection()/stopConnection()
```

This keeps `RelayRuntime` from becoming a global ownership selector or a
procedural dumping ground for binding lifecycle decisions.

## Connection Status Flow

`ConnectionManager` reports operational facts; assignment state owns the
transition and repair policy:

```text
ConnectionManager callback
  -> RelayRuntime callback wiring
  -> RuntimeAssignmentService.handleOwnedConnectionStatus()
  -> RuntimeOwnershipState transition
  -> optional reconnect timer
  -> ConnectionManager.restartConnection(binding)
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

## Shutdown Flow

```text
GatewayServer.shutdown()
  -> OutboxWorker.stop()
  -> RelayRuntime.shutdown()
       -> RuntimeScheduler.stop()
       -> DomainEventBridge.stop()
       -> RuntimeAssignmentService.clearReconnectsForOwnedBindings()
       -> ConnectionManager.stopAllConnections()
       -> RuntimeAgentRegistry.stopAllClients()
```

## Boundaries

`RelayRuntime` should not:

- infer global ownership from domain events
- scan the database to decide all desired bindings
- expose `attachBinding`, `refreshBinding`, or `detachBinding`
- embed Redis binding lease behavior
- let callers manipulate `ConnectionManager` as business truth

`RelayRuntime` may:

- own runtime lifecycle sequencing
- own OpenClaw runtime/host assembly
- wire callbacks between connection execution and assignment state
- publish runtime lifecycle snapshots

## Cluster Status

Cluster mode is not implemented in the current production wiring.

`CLUSTER_MODE=true` fails during container construction. Redis ownership and
leader scheduler classes remain future boundaries, not active runtime behavior.
