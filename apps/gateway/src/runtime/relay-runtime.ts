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

  private agentsById = new Map<string, AgentConfig>();
  private agentsByUrl = new Map<string, AgentConfig>();
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
    this.agentsById = new Map();
    this.agentsByUrl = new Map();
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
    await this.publishNodeSnapshot(
      this.nodeState.markReady(this.ownershipState.listConnectionStatuses()),
    );
  }

  async shutdown(): Promise<void> {
    await this.publishNodeSnapshot(
      this.nodeState.markStopping(this.ownershipState.listConnectionStatuses()),
    );
    for (const bindingId of this.listOwnedBindingIds()) {
      this.ownershipState.clearReconnect(bindingId);
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
    const ownershipUpdate = this.ownershipState.upsertBinding(binding, {
      forceRestart: options.forceRestart ?? false,
      hasActiveConnection: this.hasActiveConnection(binding.id),
      runnable: this.isRunnableBinding(binding),
    });

    this.rebuildOpenClawConfig();

    if (ownershipUpdate.publishSnapshot) {
      await this.publishNodeSnapshot();
    }

    if (ownershipUpdate.shouldStop) {
      this.ownershipState.clearReconnect(binding.id);
      await this.connectionManager.stopConnection(binding.id);
      return;
    }

    if (!ownershipUpdate.shouldRestart) {
      return;
    }

    this.ownershipState.clearReconnect(binding.id);
    await this.connectionManager.restartConnection(binding);
  }

  async applyBindingDelete(bindingId: string): Promise<void> {
    if (!this.ownershipState.releaseBinding(bindingId)) {
      return;
    }

    this.rebuildOpenClawConfig();
    await this.publishNodeSnapshot();
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

    this.rebuildOpenClawConfig();

    const affectedBindings = this.listBindings().filter(
      (binding) =>
        binding.agentId === agent.id &&
        !options.skipRestartBindingIds?.includes(binding.id),
    );

    for (const binding of affectedBindings) {
      await this.applyBindingUpsert(binding, { forceRestart: true });
    }
  }

  async applyAgentDelete(agentId: string): Promise<void> {
    const existing = this.agentsById.get(agentId);
    if (!existing) {
      return;
    }

    this.agentsById.delete(agentId);
    this.agentsByUrl.delete(existing.url);
    this.rebuildOpenClawConfig();
    await this.agentClientRegistry.remove(existing);
  }

  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  listBindings(): ChannelBinding[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    return this.ownershipState.listOwnedBindings().map(({ binding }) => binding.id);
  }

  hasActiveConnection(bindingId: string): boolean {
    return this.connectionManager.hasConnection(bindingId);
  }

  private applyOwnedConnectionStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: unknown,
  ): void {
    if (!this.ownershipState.getOwnedBinding(bindingId)) {
      return;
    }

    switch (status) {
      case "connecting":
        this.ownershipState.markConnecting(bindingId, agentUrl);
        break;
      case "connected":
        this.ownershipState.markConnected(bindingId, agentUrl);
        break;
      case "disconnected": {
        const decision = this.ownershipState.markDisconnected(bindingId, agentUrl);
        this.ownershipState.scheduleReconnect(bindingId, decision.delayMs, async () => {
          const latestOwnedBinding = this.ownershipState.getOwnedBinding(bindingId);
          if (!latestOwnedBinding) {
            return;
          }

          const latestBinding = latestOwnedBinding.binding;
          if (!latestBinding.enabled || !this.isRunnableBinding(latestBinding)) {
            return;
          }

          await this.connectionManager.restartConnection(latestBinding);
        });
        break;
      }
      case "error": {
        const decision = this.ownershipState.markError(
          bindingId,
          error ?? new Error("Unknown connection error"),
          agentUrl,
        );
        this.ownershipState.scheduleReconnect(bindingId, decision.delayMs, async () => {
          const latestOwnedBinding = this.ownershipState.getOwnedBinding(bindingId);
          if (!latestOwnedBinding) {
            return;
          }

          const latestBinding = latestOwnedBinding.binding;
          if (!latestBinding.enabled || !this.isRunnableBinding(latestBinding)) {
            return;
          }

          await this.connectionManager.restartConnection(latestBinding);
        });
        break;
      }
      case "idle":
        this.ownershipState.markIdle(bindingId);
        break;
    }

    this.publishNodeSnapshotInBackground();
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

  private rebuildOpenClawConfig(): void {
    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.ownershipState.listOwnedBindings().map(({ binding }) => binding),
      this.agentsById,
    );
  }

  private async publishNodeSnapshot(
    snapshot: LocalRuntimeSnapshot = this.nodeState.snapshot(
      this.ownershipState.listConnectionStatuses(),
    ),
  ): Promise<void> {
    const publish = this.nodeSnapshotPublishQueue.then(() =>
      this.stateStore.publishNodeSnapshot(snapshot),
    );
    this.nodeSnapshotPublishQueue = publish.catch(() => {});
    await publish;
  }

  private publishNodeSnapshotInBackground(
    snapshot: LocalRuntimeSnapshot = this.nodeState.snapshot(
      this.ownershipState.listConnectionStatuses(),
    ),
  ): void {
    void this.publishNodeSnapshot(snapshot).catch((error) => {
      console.error("[runtime] failed to publish node snapshot:", error);
    });
  }
}
