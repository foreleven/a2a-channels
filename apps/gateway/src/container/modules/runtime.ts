import { ContainerModule } from "inversify";

import { AgentClientRegistry } from "../../runtime/agent-client-registry.js";
import { ConnectionManagerProvider } from "../../runtime/connection-manager-provider.js";
import { InMemoryRuntimeOwnershipState, RuntimeOwnershipStateToken } from "../../runtime/ownership-state.js";
import { LocalNodeRuntimeStateStore } from "../../runtime/local-node-runtime-state-store.js";
import { NodeRuntimeStateStoreToken } from "../../runtime/node-runtime-state-store.js";
import { PluginHostProvider } from "../../runtime/plugin-host-provider.js";
import { RelayRuntimeAssemblyHandle } from "../../runtime/relay-runtime-assembly-handle.js";
import { RelayRuntimeAssemblyProvider } from "../../runtime/relay-runtime-assembly-provider.js";
import { RelayRuntime } from "../../runtime/relay-runtime.js";
import { RuntimeAgentCatalog } from "../../runtime/runtime-agent-catalog.js";
import { RuntimeAssignmentService } from "../../runtime/runtime-assignment-service.js";
import { RuntimeAssignmentCoordinator } from "../../runtime/runtime-assignment-coordinator.js";
import { RuntimeBootstrapper } from "../../runtime/runtime-bootstrapper.js";
import { RuntimeClusterStateReader } from "../../runtime/runtime-cluster-state-reader.js";
import { RuntimeBindingStateService } from "../../runtime/runtime-binding-state-service.js";
import { RuntimeBindingPolicy } from "../../runtime/runtime-binding-policy.js";
import { RuntimeNodeState } from "../../runtime/runtime-node-state.js";
import { RuntimeOwnedBindingManager } from "../../runtime/runtime-owned-binding-manager.js";
import { RuntimeSnapshotPublisher } from "../../runtime/runtime-snapshot-publisher.js";
import { TransportRegistryProvider } from "../../runtime/transport-registry-provider.js";

export function buildRuntimeModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(LocalNodeRuntimeStateStore).toSelf().inSingletonScope();
    bind(NodeRuntimeStateStoreToken).toService(LocalNodeRuntimeStateStore);

    bind(PluginHostProvider).toSelf().inSingletonScope();
    bind(ConnectionManagerProvider).toSelf().inSingletonScope();
    bind(RelayRuntimeAssemblyProvider).toSelf().inSingletonScope();

    bind(TransportRegistryProvider).toSelf().inSingletonScope();

    bind(RuntimeNodeState).toSelf().inSingletonScope();
    bind(RuntimeBindingPolicy).toSelf().inSingletonScope();
    bind(RuntimeBindingStateService).toSelf().inSingletonScope();
    bind(RuntimeOwnedBindingManager).toSelf().inSingletonScope();
    bind(RuntimeSnapshotPublisher).toSelf().inSingletonScope();

    bind(AgentClientRegistry).toSelf().inSingletonScope();
    bind(RuntimeAgentCatalog).toSelf().inSingletonScope();

    bind(InMemoryRuntimeOwnershipState).toSelf().inSingletonScope();
    bind(RuntimeOwnershipStateToken).toService(InMemoryRuntimeOwnershipState);

    bind(RelayRuntimeAssemblyHandle).toSelf().inSingletonScope();
    bind(RuntimeAssignmentService).toSelf().inSingletonScope();
    bind(RelayRuntime).toSelf().inSingletonScope();

    bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
    bind(RuntimeClusterStateReader).toSelf().inSingletonScope();
    bind(RuntimeBootstrapper).toSelf().inSingletonScope();
  });
}
