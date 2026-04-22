import { inject, injectable } from "inversify";
import {
  RelayRuntimeAssemblyProvider,
  type RelayRuntimeAssembly,
} from "./relay-runtime-assembly-provider.js";
import { RuntimeAgentCatalog } from "./runtime-agent-catalog.js";
import { RuntimeOwnedBindingManager } from "./runtime-owned-binding-manager.js";

@injectable()
export class RelayRuntimeAssemblyHandle {
  readonly runtime: RelayRuntimeAssembly["runtime"];
  readonly pluginHost: RelayRuntimeAssembly["pluginHost"];
  readonly connectionManager: RelayRuntimeAssembly["connectionManager"];

  constructor(
    @inject(RelayRuntimeAssemblyProvider)
    assemblyProvider: RelayRuntimeAssemblyProvider,
    @inject(RuntimeAgentCatalog)
    agentCatalog: RuntimeAgentCatalog,
    @inject(RuntimeOwnedBindingManager)
    ownedBindingManager: RuntimeOwnedBindingManager,
  ) {
    const assembly = assemblyProvider.create({
      loadConfig: () => agentCatalog.getConfig(),
      getAgentClient: (agentId) => agentCatalog.getAgentClient(agentId),
      callbacks: {
        onConnectionStatus: ({ binding, status, agentUrl, error }) => {
          ownedBindingManager.handleOwnedConnectionStatus(binding.id, status, {
            agentUrl,
            error,
            restartConnection: async (nextBinding) => {
              await this.connectionManager.restartConnection(nextBinding);
            },
          });
        },
        onAgentCallFailed: ({ binding, error }) => {
          console.error(
            `[runtime] agent call failed for binding ${binding.id}:`,
            String(error),
          );
        },
      },
    });

    this.runtime = assembly.runtime;
    this.pluginHost = assembly.pluginHost;
    this.connectionManager = assembly.connectionManager;
  }
}
