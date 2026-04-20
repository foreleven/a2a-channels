import type {
  AgentClientHandle,
  AgentConfig,
  AgentTransport,
  ChannelBinding,
} from "@a2a-channels/core";
import { A2ATransport, ACPTransport } from "@a2a-channels/agent-transport";
import { TransportRegistry } from "@a2a-channels/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { ConnectionManager } from "../connection-manager.js";
import { registerAllPlugins } from "../register-plugins.js";
import type { DomainEventBus } from "../domain/event-bus.js";
import {
  createAgentClientHandle,
  startAgentClients,
  stopAgentClients,
} from "./agent-clients.js";
import {
  buildOpenClawConfigFromBindings,
  hasValidFeishuCredentials,
} from "./openclaw-config.js";
import { loadRuntimeStateSnapshot } from "./state.js";

export interface RelayRuntimeOptions {
  name?: string;
  bindings: ChannelBinding[];
  agents: AgentConfig[];
  transports: AgentTransport[];
  /** Optional event bus to subscribe for reactive updates. */
  eventBus?: DomainEventBus;
}

export class RelayRuntime {
  readonly name: string;
  readonly transportRegistry: TransportRegistry;
  readonly runtime: OpenClawPluginRuntime;
  readonly pluginHost: OpenClawPluginHost;
  readonly connectionManager: ConnectionManager;

  private bindingsById = new Map<string, ChannelBinding>();
  private agentsById = new Map<string, AgentConfig>();
  private agentsByUrl = new Map<string, AgentConfig>();
  private clients = new Map<string, AgentClientHandle>();
  private openClawConfig: OpenClawConfig;

  constructor(private readonly options: RelayRuntimeOptions) {
    this.name = options.name ?? "local";
    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.options.bindings,
    );

    console.log("[RelayRuntime] config=", this.openClawConfig);

    this.bindingsById = new Map(
      options.bindings.map((binding) => [binding.id, binding]),
    );
    this.agentsById = new Map(options.agents.map((agent) => [agent.id, agent]));
    this.agentsByUrl = new Map(
      options.agents.map((agent) => [agent.url, agent]),
    );

    this.transportRegistry = new TransportRegistry();
    for (const transport of options.transports) {
      this.transportRegistry.register(transport);
    }

    let connectionManager!: ConnectionManager;

    this.runtime = new OpenClawPluginRuntime({
      config: {
        loadConfig: () => {
          return this.openClawConfig;
        },
        writeConfigFile: async () => {
          throw Error("Not implemented");
        },
      },
      handleChannelReplyEvent: (event) => connectionManager.handleEvent(event),
    });

    this.pluginHost = new OpenClawPluginHost(this.runtime);
    connectionManager = new ConnectionManager(
      this.pluginHost,
      () => this.listEnabledBindings(),
      (agentUrl) => this.getAgentClient(agentUrl),
      (event) => this.runtime.emit("message:inbound", event),
      (event) => this.runtime.emit("message:outbound", event),
    );
    this.connectionManager = connectionManager;

    // Wire up domain event subscriptions if a bus was provided.
    if (options.eventBus) {
      this.subscribeToEventBus(options.eventBus);
    }
  }

  static async load(eventBus?: DomainEventBus): Promise<RelayRuntime> {
    const snapshot = await loadRuntimeStateSnapshot();
    const runtime = new RelayRuntime({
      name: "local",
      bindings: snapshot.bindings,
      agents: snapshot.agents,
      transports: [new A2ATransport(), new ACPTransport()],
      eventBus,
    });

    return runtime;
  }

  async bootstrap(): Promise<void> {
    this.clients = this.buildAgentClients(this.options.agents);
    await startAgentClients(this.clients.values());
    registerAllPlugins(this.pluginHost);
    await this.connectionManager.syncConnections();
  }

  async shutdown(): Promise<void> {
    await this.connectionManager.stopAllConnections();
    await stopAgentClients(this.clients.values());
  }

  // -------------------------------------------------------------------------
  // Domain event subscriptions
  // -------------------------------------------------------------------------

  /**
   * Subscribe to all relevant domain events on `bus` so the runtime reacts
   * to binding/agent changes automatically, without requiring direct calls
   * from the HTTP layer.
   */
  subscribeToEventBus(bus: DomainEventBus): void {
    bus.on("ChannelBindingCreated.v1", (e) => {
      const binding: ChannelBinding = {
        id: e.bindingId,
        name: e.name,
        channelType: e.channelType,
        accountId: e.accountId,
        channelConfig: e.channelConfig,
        agentUrl: e.agentUrl,
        enabled: e.enabled,
        createdAt: e.occurredAt,
      };
      this.applyBindingUpsert(binding).catch((err: unknown) => {
        console.error("[RelayRuntime] ChannelBindingCreated handler failed", err);
      });
    });

    bus.on("ChannelBindingUpdated.v1", (e) => {
      const existing = this.bindingsById.get(e.bindingId);
      if (!existing) return;
      const updated: ChannelBinding = {
        ...existing,
        ...e.changes,
        channelConfig: e.changes.channelConfig ?? existing.channelConfig,
      };
      this.applyBindingUpsert(updated).catch((err: unknown) => {
        console.error("[RelayRuntime] ChannelBindingUpdated handler failed", err);
      });
    });

    bus.on("ChannelBindingDeleted.v1", (e) => {
      this.applyBindingDelete(e.bindingId).catch((err: unknown) => {
        console.error("[RelayRuntime] ChannelBindingDeleted handler failed", err);
      });
    });

    bus.on("AgentRegistered.v1", (e) => {
      const agent: AgentConfig = {
        id: e.agentId,
        name: e.name,
        url: e.url,
        protocol: e.protocol,
        description: e.description,
        createdAt: e.occurredAt,
      };
      this.applyAgentUpsert(agent).catch((err: unknown) => {
        console.error("[RelayRuntime] AgentRegistered handler failed", err);
      });
    });

    bus.on("AgentUpdated.v1", (e) => {
      const existing = this.agentsById.get(e.agentId);
      if (!existing) return;
      const c = e.changes;
      const updated: AgentConfig = {
        ...existing,
        ...(c.name !== undefined && { name: c.name }),
        ...(c.url !== undefined && { url: c.url }),
        ...(c.protocol !== undefined && { protocol: c.protocol }),
        ...(c.description !== undefined && {
          description: c.description ?? undefined,
        }),
      };
      this.applyAgentUpsert(updated).catch((err: unknown) => {
        console.error("[RelayRuntime] AgentUpdated handler failed", err);
      });
    });

    bus.on("AgentDeleted.v1", (e) => {
      this.applyAgentDelete(e.agentId).catch((err: unknown) => {
        console.error("[RelayRuntime] AgentDeleted handler failed", err);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Mutation helpers (also reachable directly for tests / back-compat)
  // -------------------------------------------------------------------------

  async applyBindingUpsert(binding: ChannelBinding): Promise<void> {
    const previous = this.bindingsById.get(binding.id);
    if (previous && this.areBindingsEquivalent(previous, binding)) {
      return;
    }

    this.bindingsById.set(binding.id, binding);
    this.openClawConfig = buildOpenClawConfigFromBindings(this.listBindings());

    await this.connectionManager.restartConnection(binding);
  }

  async applyBindingDelete(bindingId: string): Promise<void> {
    const existing = this.bindingsById.get(bindingId);
    if (!existing) {
      return;
    }

    this.bindingsById.delete(bindingId);
    this.openClawConfig = buildOpenClawConfigFromBindings(this.listBindings());

    await this.connectionManager.stopConnection(bindingId);
  }

  async applyAgentUpsert(agent: AgentConfig): Promise<void> {
    const previous = this.agentsById.get(agent.id);
    const previousClient = previous?.url
      ? this.clients.get(previous.url)
      : undefined;

    this.agentsById.set(agent.id, agent);
    this.agentsByUrl = new Map(
      Array.from(this.agentsById.values(), (item) => [item.url, item]),
    );

    if (
      previousClient &&
      previous?.url === agent.url &&
      previous.protocol === agent.protocol
    ) {
      return;
    }

    if (previousClient) {
      this.clients.delete(previous!.url);
      await stopAgentClients([previousClient]);
    }

    const nextClient = this.createAgentClient(agent);
    this.clients.set(agent.url, nextClient);
    await startAgentClients([nextClient]);
  }

  async applyAgentDelete(agentId: string): Promise<void> {
    const existing = this.agentsById.get(agentId);
    if (!existing) {
      return;
    }

    this.agentsById.delete(agentId);
    this.agentsByUrl.delete(existing.url);

    const client = this.clients.get(existing.url);
    if (!client) {
      return;
    }

    this.clients.delete(existing.url);
    await stopAgentClients([client]);
  }

  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  listBindings(): ChannelBinding[] {
    return Array.from(this.bindingsById.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  listEnabledBindings(): ChannelBinding[] {
    return this.listBindings().filter(
      (binding) => binding.enabled && this.isRunnableBinding(binding),
    );
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agentsById.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  private async getAgentClient(agentUrl: string): Promise<AgentClientHandle> {
    return (
      this.clients.get(agentUrl) ??
      createAgentClientHandle(
        {
          id: agentUrl,
          name: agentUrl,
          url: agentUrl,
          protocol: this.getAgentProtocolForUrl(agentUrl),
          createdAt: new Date(0).toISOString(),
        },
        this.transportRegistry.resolve(this.getAgentProtocolForUrl(agentUrl)),
      )
    );
  }

  private getAgentProtocolForUrl(agentUrl: string): string {
    return this.agentsByUrl.get(agentUrl)?.protocol ?? "a2a";
  }

  private createAgentClient(agent: AgentConfig): AgentClientHandle {
    return createAgentClientHandle(
      agent,
      this.transportRegistry.resolve(agent.protocol ?? "a2a"),
    );
  }

  private isRunnableBinding(binding: ChannelBinding): boolean {
    if (hasValidFeishuCredentials(binding)) {
      return true;
    }

    console.warn(
      `[gateway] skipping binding ${binding.id} for ${binding.channelType}:${binding.accountId} because appId/appSecret are missing`,
    );
    return false;
  }

  private areBindingsEquivalent(
    left: ChannelBinding,
    right: ChannelBinding,
  ): boolean {
    return (
      left.name === right.name &&
      left.channelType === right.channelType &&
      left.accountId === right.accountId &&
      left.agentUrl === right.agentUrl &&
      left.enabled === right.enabled &&
      JSON.stringify(left.channelConfig) === JSON.stringify(right.channelConfig)
    );
  }

  private buildAgentClients(
    agents: AgentConfig[],
  ): Map<string, AgentClientHandle> {
    return new Map(
      agents.map((agent) => [agent.url, this.createAgentClient(agent)]),
    );
  }
}
