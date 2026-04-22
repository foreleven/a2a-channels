import { inject, injectable } from "inversify";
import type {
  AgentConfig,
  ChannelBinding,
  RuntimeConnectionStatus,
} from "@a2a-channels/core";

import { RelayRuntimeAssemblyHandle } from "./relay-runtime-assembly-handle.js";
import { RuntimeAgentCatalog } from "./runtime-agent-catalog.js";
import {
  RuntimeOwnedBindingManager,
  type RuntimeOwnedBindingHooks,
} from "./runtime-owned-binding-manager.js";

interface ApplyAgentUpsertOptions {
  skipRestartBindingIds?: string[];
}

@injectable()
export class RuntimeAssignmentService {
  private readonly ownedBindingHooks: RuntimeOwnedBindingHooks;

  constructor(
    @inject(RuntimeAgentCatalog)
    private readonly agentCatalog: RuntimeAgentCatalog,
    @inject(RuntimeOwnedBindingManager)
    private readonly ownedBindingManager: RuntimeOwnedBindingManager,
    @inject(RelayRuntimeAssemblyHandle)
    private readonly assembly: RelayRuntimeAssemblyHandle,
  ) {
    this.ownedBindingHooks = {
      hasActiveConnection: (bindingId) =>
        this.assembly.connectionManager.hasConnection(bindingId),
      onBindingsChanged: () => {
        this.agentCatalog.rebuildConfig();
      },
      restartConnection: async (binding) => {
        await this.assembly.connectionManager.restartConnection(binding);
      },
      stopConnection: async (bindingId) => {
        await this.assembly.connectionManager.stopConnection(bindingId);
      },
    };
  }

  async assignBinding(binding: ChannelBinding, agent: AgentConfig): Promise<void> {
    const previousAgent = this.agentCatalog.getAgent(agent.id);
    const agentChanged =
      !previousAgent ||
      previousAgent.url !== agent.url ||
      previousAgent.protocol !== agent.protocol;

    if (agentChanged) {
      await this.applyAgentUpsert(agent, {
        skipRestartBindingIds: [binding.id],
      });
    }

    await this.ownedBindingManager.applyBindingUpsert(
      binding,
      this.ownedBindingHooks,
      { forceRestart: agentChanged },
    );
  }

  async releaseBinding(bindingId: string): Promise<void> {
    await this.ownedBindingManager.applyBindingDelete(
      bindingId,
      this.ownedBindingHooks,
    );
  }

  async applyAgentUpsert(
    agent: AgentConfig,
    options: ApplyAgentUpsertOptions = {},
  ): Promise<void> {
    await this.agentCatalog.upsertAgent(agent);

    const affectedBindings = this.listBindings().filter(
      (binding) =>
        binding.agentId === agent.id &&
        !options.skipRestartBindingIds?.includes(binding.id),
    );

    for (const binding of affectedBindings) {
      await this.ownedBindingManager.applyBindingUpsert(
        binding,
        this.ownedBindingHooks,
        { forceRestart: true },
      );
    }
  }

  listBindings(): ChannelBinding[] {
    return this.ownedBindingManager.listBindings();
  }

  listEnabledBindings(): ChannelBinding[] {
    return this.ownedBindingManager.listEnabledBindings();
  }

  listOwnedBindingIds(): string[] {
    return this.ownedBindingManager.listOwnedBindingIds();
  }

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.ownedBindingManager.listConnectionStatuses();
  }

  clearReconnectsForOwnedBindings(): void {
    this.ownedBindingManager.clearReconnectsForOwnedBindings();
  }
}
