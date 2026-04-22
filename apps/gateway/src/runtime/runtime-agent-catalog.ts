import { inject, injectable } from "inversify";
import type {
  AgentClientHandle,
  AgentConfig,
  TransportRegistry,
} from "@a2a-channels/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { AgentClientRegistry } from "./agent-client-registry.js";
import { buildOpenClawConfigFromBindings } from "./openclaw-config.js";
import { RuntimeOwnedBindingManager } from "./runtime-owned-binding-manager.js";

@injectable()
export class RuntimeAgentCatalog {
  readonly transportRegistry: TransportRegistry;

  private agentsById = new Map<string, AgentConfig>();
  private openClawConfig: OpenClawConfig;

  constructor(
    @inject(AgentClientRegistry)
    private readonly agentClientRegistry: AgentClientRegistry,
    @inject(RuntimeOwnedBindingManager)
    private readonly ownedBindingManager: RuntimeOwnedBindingManager,
  ) {
    this.transportRegistry = this.agentClientRegistry.transportRegistry;
    this.openClawConfig = buildOpenClawConfigFromBindings([], this.agentsById);
  }

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agentsById.get(agentId);
  }

  async upsertAgent(agent: AgentConfig): Promise<void> {
    const previous = this.agentsById.get(agent.id);
    this.agentsById.set(agent.id, agent);
    await this.agentClientRegistry.upsert(agent, previous);
    this.rebuildConfig();
  }

  async deleteAgent(agentId: string): Promise<void> {
    const existing = this.agentsById.get(agentId);
    if (!existing) {
      return;
    }

    this.agentsById.delete(agentId);
    this.rebuildConfig();
    await this.agentClientRegistry.remove(existing);
  }

  async stopAllClients(): Promise<void> {
    await this.agentClientRegistry.stopAll();
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agentsById.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  async getAgentClient(
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

  rebuildConfig(): void {
    this.openClawConfig = buildOpenClawConfigFromBindings(
      this.ownedBindingManager.listBindings(),
      this.agentsById,
    );
  }
}
