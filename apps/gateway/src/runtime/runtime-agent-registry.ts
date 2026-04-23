import { inject, injectable } from "inversify";
import type { AgentClientHandle, AgentConfig } from "@a2a-channels/core";

import { AgentClientRegistry } from "./agent-client-registry.js";

@injectable()
export class RuntimeAgentRegistry {
  private readonly agentsById = new Map<string, AgentConfig>();

  constructor(
    @inject(AgentClientRegistry)
    private readonly agentClientRegistry: AgentClientRegistry,
  ) {}

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agentsById.get(agentId);
  }

  async upsertAgent(agent: AgentConfig): Promise<void> {
    const previous = this.agentsById.get(agent.id);
    this.agentsById.set(agent.id, agent);
    await this.agentClientRegistry.upsert(agent, previous);
  }

  async deleteAgent(agentId: string): Promise<void> {
    const existing = this.agentsById.get(agentId);
    if (!existing) {
      return;
    }

    this.agentsById.delete(agentId);
    await this.agentClientRegistry.remove(existing);
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agentsById.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  snapshotAgentsById(): ReadonlyMap<string, AgentConfig> {
    return new Map(this.agentsById);
  }

  async getAgentClient(
    agentId: string,
  ): Promise<{ client: AgentClientHandle; url: string }> {
    const agent = this.agentsById.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return {
      client: this.agentClientRegistry.require(agent),
      url: agent.url,
    };
  }

  async stopAllClients(): Promise<void> {
    await this.agentClientRegistry.stopAll();
  }
}
