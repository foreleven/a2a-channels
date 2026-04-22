import { ContainerModule } from "inversify";

import { AgentClientRegistry } from "../../runtime/agent-client-registry.js";
import {
  InMemoryRuntimeOwnershipState,
  RuntimeOwnershipStateToken,
} from "../../runtime/ownership-state.js";
import { LocalNodeRuntimeStateStore } from "../../runtime/local-node-runtime-state-store.js";
import { NodeRuntimeStateStoreToken } from "../../runtime/node-runtime-state-store.js";
import { ConnectionManager } from "../../runtime/connection-manager.js";
import { OpenClawRuntimeAssembler } from "../../runtime/openclaw-runtime-assembler.js";
import { RelayRuntime } from "../../runtime/relay-runtime.js";
import { RuntimeAgentCatalog } from "../../runtime/runtime-agent-catalog.js";
import { RuntimeAssignmentService } from "../../runtime/runtime-assignment-service.js";
import { RuntimeAssignmentCoordinator } from "../../runtime/runtime-assignment-coordinator.js";
import { RuntimeBootstrapper } from "../../runtime/runtime-bootstrapper.js";
import { RuntimeClusterStateReader } from "../../runtime/runtime-cluster-state-reader.js";
import { RuntimeBindingStateService } from "../../runtime/runtime-binding-state-service.js";
import { RuntimeBindingPolicy } from "../../runtime/runtime-binding-policy.js";
import { AgentClientFactory } from "../../runtime/agent-clients.js";
import { RuntimeNodeState } from "../../runtime/runtime-node-state.js";
import { RuntimeOwnedBindingManager } from "../../runtime/runtime-owned-binding-manager.js";
import { RuntimeSnapshotPublisher } from "../../runtime/runtime-snapshot-publisher.js";
import { TransportRegistryAssembler } from "../../runtime/transport-registry-assembler.js";
import { GatewayServer } from "../../bootstrap/gateway-server.js";

export function buildRuntimeModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(LocalNodeRuntimeStateStore).toSelf().inSingletonScope();
    bind(NodeRuntimeStateStoreToken).toService(LocalNodeRuntimeStateStore);

    bind(OpenClawRuntimeAssembler).toSelf().inSingletonScope();
    bind(ConnectionManager).toSelf().inSingletonScope();

    bind(TransportRegistryAssembler).toSelf().inSingletonScope();
    bind(AgentClientFactory).toSelf().inSingletonScope();

    bind(RuntimeNodeState).toSelf().inSingletonScope();
    bind(RuntimeBindingPolicy).toSelf().inSingletonScope();
    bind(RuntimeBindingStateService).toSelf().inSingletonScope();
    bind(RuntimeOwnedBindingManager).toSelf().inSingletonScope();
    bind(RuntimeSnapshotPublisher).toSelf().inSingletonScope();

    bind(AgentClientRegistry).toSelf().inSingletonScope();
    bind(RuntimeAgentCatalog).toSelf().inSingletonScope();

    bind(InMemoryRuntimeOwnershipState).toSelf().inSingletonScope();
    bind(RuntimeOwnershipStateToken).toService(InMemoryRuntimeOwnershipState);

    bind(RuntimeAssignmentService).toSelf().inSingletonScope();
    bind(RelayRuntime).toSelf().inSingletonScope();

    bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
    bind(RuntimeClusterStateReader).toSelf().inSingletonScope();
    bind(RuntimeBootstrapper).toSelf().inSingletonScope();
    bind(GatewayServer).toSelf().inSingletonScope();
  });
}
