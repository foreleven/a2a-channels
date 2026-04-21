import { ContainerModule } from "inversify";
import { A2ATransport, ACPTransport } from "@a2a-channels/agent-transport";

import { GatewayConfigToken } from "../../bootstrap/config.js";
import { AgentClientRegistry } from "../../runtime/agent-client-registry.js";
import { LocalNodeRuntimeStateStore } from "../../runtime/local-node-runtime-state-store.js";
import { NodeRuntimeStateStoreToken } from "../../runtime/node-runtime-state-store.js";
import { PluginHostProvider } from "../../runtime/plugin-host-provider.js";
import { RelayRuntime } from "../../runtime/relay-runtime.js";
import { RuntimeAssignmentCoordinator } from "../../runtime/runtime-assignment-coordinator.js";
import { RuntimeBootstrapper } from "../../runtime/runtime-bootstrapper.js";
import { RuntimeClusterStateReader } from "../../runtime/runtime-cluster-state-reader.js";
import { RuntimeNodeState } from "../../runtime/runtime-node-state.js";
import { TransportRegistryProvider } from "../../runtime/transport-registry-provider.js";

export function buildRuntimeModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(LocalNodeRuntimeStateStore)
      .toDynamicValue(() => new LocalNodeRuntimeStateStore())
      .inSingletonScope();
    bind(NodeRuntimeStateStoreToken).toService(LocalNodeRuntimeStateStore);

    bind(PluginHostProvider)
      .toDynamicValue(() => new PluginHostProvider())
      .inSingletonScope();

    bind(TransportRegistryProvider)
      .toDynamicValue(
        () => new TransportRegistryProvider([new A2ATransport(), new ACPTransport()]),
      )
      .inSingletonScope();

    bind(RuntimeNodeState)
      .toDynamicValue((context) => new RuntimeNodeState(context.get(GatewayConfigToken)))
      .inSingletonScope();

    bind(AgentClientRegistry)
      .toDynamicValue(
        (context) => new AgentClientRegistry(context.get(TransportRegistryProvider)),
      )
      .inSingletonScope();

    bind(RelayRuntime)
      .toDynamicValue(
        (context) =>
          new RelayRuntime({
            name: "local",
            config: context.get(GatewayConfigToken),
            runtimeNodeState: context.get(RuntimeNodeState),
            stateStore: context.get(NodeRuntimeStateStoreToken),
            pluginHostProvider: context.get(PluginHostProvider),
            agentClientRegistry: context.get(AgentClientRegistry),
          }),
      )
      .inSingletonScope();

    bind(RuntimeAssignmentCoordinator).toDynamicValue(
      (context) => new RuntimeAssignmentCoordinator(context.get(RelayRuntime)),
    ).inSingletonScope();
    bind(RuntimeClusterStateReader).toSelf().inSingletonScope();
    bind(RuntimeBootstrapper).toSelf().inSingletonScope();
  });
}
