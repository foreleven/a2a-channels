import { inject, injectable } from "inversify";
import type {
  AgentClientHandle,
  AgentConfig,
  ChannelBinding,
  RuntimeConnectionStatus,
  TransportRegistry,
} from "@a2a-channels/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { AgentClientRegistry } from "./agent-client-registry.js";
import { NodeRuntimeStateStoreToken } from "./node-runtime-state-store.js";
import type { NodeRuntimeStateStore } from "./node-runtime-state-store.js";
import {
  buildOpenClawConfigFromBindings,
} from "./openclaw-config.js";
import {
  type RuntimeOwnershipState,
  RuntimeOwnershipStateToken,
} from "./ownership-state.js";
import {
  RelayRuntimeAssemblyProvider,
  type RelayRuntimeAssembly,
} from "./relay-runtime-assembly-provider.js";
import {
  RuntimeNodeState,
  type LocalRuntimeSnapshot,
} from "./runtime-node-state.js";

interface ApplyAgentUpsertOptions {
  skipRestartBindingIds?: string[];
}

interface ApplyBindingUpsertOptions {
  forceRestart?: boolean;
}

@injectable()
export class RelayRuntime {
  readonly name = "local";
  readonly transportRegistry: TransportRegistry;
  readonly runtime: OpenClawPluginRuntime;
  readonly pluginHost: OpenClawPluginHost;
  readonly connectionManager: RelayRuntimeAssembly["connectionManager"];

  private bindingsById = new Map<string, ChannelBinding>();
  private agentsById = new Map<string, AgentConfig>();
  private agentsByUrl = new Map<string, AgentConfig>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nodeState: RuntimeNodeState;
  private readonly stateStore: NodeRuntimeStateStore;
  private readonly agentClientRegistry: AgentClientRegistry;
  private readonly ownershipState: RuntimeOwnershipState;
  private openClawConfig: OpenClawConfig;
  private nodeSnapshotPublishQueue: Promise<void> = Promise.resolve();

  constructor(
    @inject(RuntimeNodeState) runtimeNodeState: RuntimeNodeState,
    @inject(NodeRuntimeStateStoreToken)
    stateStore: NodeRuntimeStateStore,
    @inject(AgentClientRegistry) agentClientRegistry: AgentClientRegistry,
    @inject(RelayRuntimeAssemblyProvider)
    assemblyProvider: RelayRuntimeAssemblyProvider,
    @inject(RuntimeOwnershipStateToken)
    ownershipState: RuntimeOwnershipState,
  ) {
    this.nodeState = runtimeNodeState;
    this.stateStore = stateStore;
    this.agentClientRegistry = agentClientRegistry;
    this.ownershipState = ownershipState;
    this.bindingsById = new Map();
    this.agentsById = new Map();
    this.agentsByUrl = new Map();
    this.reconnectTimers = new Map();
    this.openClawConfig = buildOpenClawConfigFromBindings([], this.agentsById);
    this.transportRegistry = this.agentClientRegistry.transportRegistry;
    const assembly = assemblyProvider.create({
      loadConfig: () => this.openClawConfig,
      getAgentClient: (agentId) => this.getAgentClient(agentId),
      callbacks: {
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
    });

    this.runtime = assembly.runtime;
    this.pluginHost = assembly.pluginHost;
    this.connectionManager = assembly.connectionManager;
  }

  async bootstrap(): Promise<void> {
    await this.publishNodeSnapshot(this.nodeState.markBootstrapping());
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
  // Assignment operations
  // -------------------------------------------------------------------------

  async assignBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    const previousAgent = this.agentsById.get(agent.id);
    const agentChanged =
      !previousAgent ||
      previousAgent.url !== agent.url ||
      previousAgent.protocol !== agent.protocol;

    if (agentChanged) {
      await this.applyAgentUpsert(agent, {
        skipRestartBindingIds: [binding.id],
      });
    }

    await this.applyBindingUpsert(binding, {
      forceRestart: agentChanged,
    });
  }

  async releaseBinding(bindingId: string): Promise<void> {
    await this.applyBindingDelete(bindingId);
  }

  async attachBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    await this.assignBinding(binding, agent);
  }

  async refreshBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    await this.assignBinding(binding, agent);
  }

  async detachBinding(bindingId: string): Promise<void> {
    await this.releaseBinding(bindingId);
  }

  async applyBindingUpsert(
    binding: ChannelBinding,
    options: ApplyBindingUpsertOptions = {},
  ): Promise<void> {
    const previous = this.bindingsById.get(binding.id);
    if (this.ensureOwnershipState(binding)) {
      await this.publishNodeSnapshot(this.nodeState.attachBinding(binding.id));
    }

    if (
      previous &&
      this.areBindingsEquivalent(previous, binding) &&
      this.hasActiveConnection(binding.id) &&
      !options.forceRestart
    ) {
      this.bindingsById.set(binding.id, binding);
      return;
    }

    this.bindingsById.set(binding.id, binding);
    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.listBindings(),
      this.agentsById,
    );

    if (previous && this.areBindingsEquivalent(previous, binding) && !options.forceRestart) {
      await this.syncBindingConnection(binding);
      return;
    }

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

  listOwnedBindingIds(): string[] {
    return this.ownershipState.listConnectionStatuses().map(
      (status) => status.bindingId,
    );
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
