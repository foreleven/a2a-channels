import { inject, injectable } from "inversify";
import type {
  AgentClientHandle,
} from "@a2a-channels/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { ConnectionManager, type ConnectionManagerCallbacks } from "../connection-manager.js";
import { ConnectionManagerProvider } from "./connection-manager-provider.js";
import { PluginHostProvider } from "./plugin-host-provider.js";

export interface RelayRuntimeAssembly {
  runtime: OpenClawPluginRuntime;
  pluginHost: OpenClawPluginHost;
  connectionManager: ConnectionManager;
}

export interface RelayRuntimeAssemblyOptions {
  loadConfig: () => OpenClawConfig;
  getAgentClient: (
    agentId: string,
  ) => { client: AgentClientHandle; url: string } | Promise<{
    client: AgentClientHandle;
    url: string;
  }>;
  callbacks?: ConnectionManagerCallbacks;
}

@injectable()
export class RelayRuntimeAssemblyProvider {
  constructor(
    @inject(PluginHostProvider)
    private readonly pluginHostProvider: PluginHostProvider,
    @inject(ConnectionManagerProvider)
    private readonly connectionManagerProvider: ConnectionManagerProvider,
  ) {}

  create<T extends RelayRuntimeAssemblyOptions>(
    options: T,
  ): RelayRuntimeAssembly {
    let connectionManager!: ConnectionManager;

    const runtime = this.pluginHostProvider.createRuntime({
      config: {
        loadConfig: options.loadConfig,
        writeConfigFile: async () => {
          throw Error("Not implemented");
        },
      },
      handleChannelReplyEvent: (event) => connectionManager.handleEvent(event),
    });

    const pluginHost = this.pluginHostProvider.create(runtime);
    connectionManager = this.connectionManagerProvider.create({
      host: pluginHost,
      getAgentClient: options.getAgentClient,
      emitMessageInbound: (event) =>
        runtime.emit("message:inbound", event),
      emitMessageOutbound: (event) =>
        runtime.emit("message:outbound", event),
      callbacks: options.callbacks,
    });

    return { runtime, pluginHost, connectionManager };
  }
}
