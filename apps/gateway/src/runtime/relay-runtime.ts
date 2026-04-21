import type {
  AgentClientHandle,
  AgentConfig,
  AgentTransport,
  ChannelBinding,
  RuntimeConnectionStatus,
  TransportRegistry,
} from "@a2a-channels/core";
import { A2ATransport, ACPTransport } from "@a2a-channels/agent-transport";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { buildGatewayConfig, type GatewayConfig } from "../bootstrap/config.js";
import { ConnectionManager } from "../connection-manager.js";
import { registerAllPlugins } from "../register-plugins.js";
import { AgentClientRegistry } from "./agent-client-registry.js";
import type { NodeRuntimeStateStore } from "./node-runtime-state-store.js";
import {
  buildOpenClawConfigFromBindings,
} from "./openclaw-config.js";
import {
  createRuntimeOwnershipState,
  type RuntimeOwnershipState,
} from "./ownership-state.js";
import { createLocalOwnershipGate } from "./local-ownership-gate.js";
import type { OwnershipGate } from "./ownership-gate.js";
import { PluginHostProvider } from "./plugin-host-provider.js";
import type { ReconnectPolicy } from "./reconnect-policy.js";
import {
  RuntimeNodeState,
  type LocalRuntimeSnapshot,
} from "./runtime-node-state.js";
import { TransportRegistryProvider } from "./transport-registry-provider.js";

export interface RelayRuntimeOptions {
  name?: string;
  reconnectPolicy?: ReconnectPolicy;
  transports?: AgentTransport[];
  config?: GatewayConfig;
  runtimeNodeState?: RuntimeNodeState;
  stateStore?: NodeRuntimeStateStore;
  pluginHostProvider?: PluginHostProvider;
  agentClientRegistry?: AgentClientRegistry;
}

interface ApplyAgentUpsertOptions {
  skipRestartBindingIds?: string[];
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
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly config: GatewayConfig;
  private readonly nodeState: RuntimeNodeState;
  private readonly stateStore: NodeRuntimeStateStore;
  private readonly agentClientRegistry: AgentClientRegistry;
  private readonly ownershipState: RuntimeOwnershipState;
  private readonly ownershipGate: OwnershipGate;
  private openClawConfig: OpenClawConfig;
  private nodeSnapshotPublishQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RelayRuntimeOptions) {
    this.name = options.name ?? "local";
    this.config = options.config ?? buildGatewayConfig();
    this.bindingsById = new Map();
    this.agentsById = new Map();
    this.agentsByUrl = new Map();
    this.reconnectTimers = new Map();
    this.nodeState = options.runtimeNodeState ?? new RuntimeNodeState(this.config);
    this.stateStore = options.stateStore ?? {
      publishNodeSnapshot: async () => {},
    };
    this.agentClientRegistry =
      options.agentClientRegistry ??
      new AgentClientRegistry(
        new TransportRegistryProvider(
          options.transports ?? [new A2ATransport(), new ACPTransport()],
        ),
      );
    this.ownershipGate = createLocalOwnershipGate();
    this.ownershipState = createRuntimeOwnershipState({
      reconnectPolicy: options.reconnectPolicy,
    });
    this.openClawConfig = buildOpenClawConfigFromBindings([], this.agentsById);

    console.log("[RelayRuntime] config=", this.openClawConfig);

    this.transportRegistry = this.agentClientRegistry.transportRegistry;

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

    this.pluginHost = (options.pluginHostProvider ?? new PluginHostProvider()).create(
      this.runtime,
    );
    connectionManager = new ConnectionManager(
      this.pluginHost,
      () => this.listEnabledBindings(),
      (agentId) => this.getAgentClient(agentId),
      (event) => this.runtime.emit("message:inbound", event),
      (event) => this.runtime.emit("message:outbound", event),
      {
        onConnectionStatus: ({ binding, status, agentUrl, error }) => {
          this.applyOwnedConnectionStatus(binding.id, status, agentUrl, error);
        },
        onAgentCallFailed: ({ binding, error }) => {
          console.error(
            `[runtime] agent call failed for binding ${binding.id}:`,
            String(error),
          );
        },
      },
    );
    this.connectionManager = connectionManager;
  }

  static async load(): Promise<RelayRuntime> {
    return new RelayRuntime({
      name: "local",
      config: buildGatewayConfig(),
      transports: [new A2ATransport(), new ACPTransport()],
    });
  }

  async bootstrap(): Promise<void> {
    await this.publishNodeSnapshot(this.nodeState.markBootstrapping());
    registerAllPlugins(this.pluginHost);
    await this.publishNodeSnapshot(this.nodeState.markReady());
  }

  async shutdown(): Promise<void> {
    await this.publishNodeSnapshot(this.nodeState.markStopping());
    for (const bindingId of Array.from(this.reconnectTimers.keys())) {
      this.clearReconnectTimer(bindingId);
    }
    await this.connectionManager.stopAllConnections();
    await this.agentClientRegistry.stopAll();
    await this.publishNodeSnapshot(this.nodeState.markStopped());
  }

  // -------------------------------------------------------------------------
  // Local ownership operations
  // -------------------------------------------------------------------------

  async attachBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    await this.applyAgentUpsert(agent, {
      skipRestartBindingIds: [binding.id],
    });
    await this.applyBindingUpsert(binding);
  }

  async refreshBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    await this.attachBinding(binding, agent);
  }

  async detachBinding(bindingId: string): Promise<void> {
    await this.applyBindingDelete(bindingId);
  }

  async applyBindingUpsert(binding: ChannelBinding): Promise<void> {
    const previous = this.bindingsById.get(binding.id);
    if (this.ensureOwnershipState(binding)) {
      await this.publishNodeSnapshot(this.nodeState.attachBinding(binding.id));
    }

    if (previous && this.areBindingsEquivalent(previous, binding)) {
      await this.syncBindingConnection(binding);
      return;
    }

    this.bindingsById.set(binding.id, binding);
    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.listBindings(),
      this.agentsById,
    );

    await this.syncBindingConnection(binding);
  }

  async applyBindingDelete(bindingId: string): Promise<void> {
    const existing = this.bindingsById.get(bindingId);
    if (!existing) {
      return;
    }

    this.clearReconnectTimer(bindingId);
    this.bindingsById.delete(bindingId);
    this.ownershipState.detachBinding(bindingId);
    await this.publishNodeSnapshot(this.nodeState.detachBinding(bindingId));
    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.listBindings(),
      this.agentsById,
    );

    await this.connectionManager.stopConnection(bindingId);
  }

  async applyAgentUpsert(
    agent: AgentConfig,
    options: ApplyAgentUpsertOptions = {},
  ): Promise<void> {
    const previous = this.agentsById.get(agent.id);

    this.agentsById.set(agent.id, agent);
    this.agentsByUrl = new Map(
      Array.from(this.agentsById.values(), (item) => [item.url, item]),
    );

    await this.agentClientRegistry.upsert(agent, previous);

    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.listBindings(),
      this.agentsById,
    );

    const affectedBindings = this.listBindings().filter(
      (binding) =>
        binding.agentId === agent.id &&
        !options.skipRestartBindingIds?.includes(binding.id),
    );

    for (const binding of affectedBindings) {
      await this.syncBindingConnection(binding);
    }
  }

  async applyAgentDelete(agentId: string): Promise<void> {
    const existing = this.agentsById.get(agentId);
    if (!existing) {
      return;
    }

    this.agentsById.delete(agentId);
    this.agentsByUrl.delete(existing.url);
    await this.agentClientRegistry.remove(existing);
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

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.ownershipState.listConnectionStatuses();
  }

  hasActiveConnection(bindingId: string): boolean {
    return this.connectionManager.hasConnection(bindingId);
  }

  private ensureOwnershipState(binding: ChannelBinding): boolean {
    const isOwned = this.ownershipState
      .listConnectionStatuses()
      .some((status) => status.bindingId === binding.id);

    if (isOwned) {
      return false;
    }

    this.ownershipState.attachBinding(binding);
    return true;
  }

  private async syncBindingConnection(binding: ChannelBinding): Promise<void> {
    this.clearReconnectTimer(binding.id);
    if (!binding.enabled || !this.isRunnableBinding(binding)) {
      await this.publishNodeSnapshot(this.resetOwnershipStatusToIdle(binding));
      await this.connectionManager.stopConnection(binding.id);
      return;
    }

    await this.connectionManager.restartConnection(binding);
  }

  private resetOwnershipStatusToIdle(binding: ChannelBinding): LocalRuntimeSnapshot {
    this.ownershipState.detachBinding(binding.id);
    this.ownershipState.attachBinding(binding);
    return this.nodeState.markBindingIdle(binding.id);
  }

  private scheduleReconnect(
    bindingId: string,
    delayMs: number,
  ): void {
    this.clearReconnectTimer(bindingId);
    const binding = this.bindingsById.get(bindingId);
    if (!binding || !binding.enabled || !this.isRunnableBinding(binding)) {
      return;
    }

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(bindingId);
      const latestBinding = this.bindingsById.get(bindingId);
      if (!latestBinding || !latestBinding.enabled || !this.isRunnableBinding(latestBinding)) {
        return;
      }
      void this.connectionManager.restartConnection(latestBinding);
    }, delayMs);

    this.reconnectTimers.set(bindingId, timer);
  }

  private clearReconnectTimer(bindingId: string): void {
    const timer = this.reconnectTimers.get(bindingId);
    if (timer) {
      clearTimeout(timer);
    }
    this.reconnectTimers.delete(bindingId);
  }

  private applyOwnedConnectionStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: unknown,
  ): void {
    const binding = this.bindingsById.get(bindingId);
    if (!binding) {
      return;
    }

    this.ensureOwnershipState(binding);
    let snapshot: LocalRuntimeSnapshot | undefined;

    switch (status) {
      case "connecting":
        this.clearReconnectTimer(bindingId);
        this.ownershipState.markConnecting(bindingId, agentUrl);
        snapshot = this.nodeState.markBindingConnecting(bindingId, agentUrl);
        break;
      case "connected":
        this.clearReconnectTimer(bindingId);
        this.ownershipState.markConnected(bindingId, agentUrl);
        snapshot = this.nodeState.markBindingConnected(bindingId, agentUrl);
        break;
      case "disconnected": {
        const decision = this.ownershipState.markDisconnected(bindingId, agentUrl);
        snapshot = this.nodeState.markBindingDisconnected(bindingId, agentUrl);
        this.scheduleReconnect(bindingId, decision.delayMs);
        break;
      }
      case "error": {
        const decision = this.ownershipState.markError(
          bindingId,
          error ?? new Error("Unknown connection error"),
          agentUrl,
        );
        snapshot = this.nodeState.markBindingError(
          bindingId,
          error ?? new Error("Unknown connection error"),
          agentUrl,
        );
        this.scheduleReconnect(bindingId, decision.delayMs);
        break;
      }
      case "idle":
        snapshot = this.nodeState.markBindingIdle(bindingId);
        break;
    }

    if (snapshot) {
      this.publishNodeSnapshotInBackground(snapshot);
    }
  }

  private async getAgentClient(
    agentId: string,
  ): Promise<{ client: AgentClientHandle; url: string }> {
    const agent = this.agentsById.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return {
      client: this.agentClientRegistry.get(agent),
      url: agent.url,
    };
  }

  private isRunnableBinding(binding: ChannelBinding): boolean {
    if (
      binding.channelType !== "feishu" &&
      binding.channelType !== "lark"
    ) {
      return true;
    }

    const config = binding.channelConfig as {
      appId?: unknown;
      appSecret?: unknown;
    };
    const hasCredentials =
      typeof config.appId === "string" &&
      config.appId.trim().length > 0 &&
      typeof config.appSecret === "string" &&
      config.appSecret.trim().length > 0;

    if (hasCredentials) {
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
      left.agentId === right.agentId &&
      left.enabled === right.enabled &&
      JSON.stringify(left.channelConfig) === JSON.stringify(right.channelConfig)
    );
  }

  private async publishNodeSnapshot(
    snapshot: LocalRuntimeSnapshot = this.nodeState.snapshot(),
  ): Promise<void> {
    const publish = this.nodeSnapshotPublishQueue.then(() =>
      this.stateStore.publishNodeSnapshot(snapshot),
    );
    this.nodeSnapshotPublishQueue = publish.catch(() => {});
    await publish;
  }

  private publishNodeSnapshotInBackground(
    snapshot: LocalRuntimeSnapshot = this.nodeState.snapshot(),
  ): void {
    void this.publishNodeSnapshot(snapshot).catch((error) => {
      console.error("[runtime] failed to publish node snapshot:", error);
    });
  }
}
