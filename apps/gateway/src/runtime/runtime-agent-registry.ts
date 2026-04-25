import { inject, injectable } from "inversify";
import type { AgentClientHandle } from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentClientRegistry } from "./agent-client-registry.js";

/** Maintains runtime agent snapshots and their transport client registrations. */
@injectable()
export class RuntimeAgentRegistry {
  private readonly agentsById = new Map<string, AgentConfigSnapshot>();

  /** Receives the URL-keyed client registry backing each agent snapshot. */
  constructor(
    @inject(AgentClientRegistry)
    private readonly agentClientRegistry: AgentClientRegistry,
  ) {}

  /** Looks up the current runtime snapshot for an agent id. */
  getAgent(agentId: string): AgentConfigSnapshot | undefined {
    return this.agentsById.get(agentId);
  }

  /** Stores an agent snapshot and prepares its transport client. */
  async upsertAgent(agent: AgentConfigSnapshot): Promise<void> {
    const previous = this.agentsById.get(agent.id);
    this.agentsById.set(agent.id, agent);
    await this.agentClientRegistry.upsert(agent, previous);
  }

  /** Removes an agent snapshot and stops its registered transport client. */
  async deleteAgent(agentId: string): Promise<void> {
    const existing = this.agentsById.get(agentId);
    if (!existing) {
      return;
    }

    this.agentsById.delete(agentId);
    await this.agentClientRegistry.remove(existing);
  }

  /** Lists current agent snapshots in creation order for stable projections. */
  listAgents(): AgentConfigSnapshot[] {
    return Array.from(this.agentsById.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  /** Returns a read-only copy of the agent lookup map. */
  snapshotAgentsById(): ReadonlyMap<string, AgentConfigSnapshot> {
    return new Map(this.agentsById);
  }

  /** Resolves the active client and target URL for a binding's agent id. */
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

  /** Stops every registered agent client during runtime shutdown. */
  async stopAllClients(): Promise<void> {
    await this.agentClientRegistry.stopAll();
  }
}
