import { inject, injectable } from "inversify";
import type { AgentClient } from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentClientFactory } from "./agent-clients.js";

/** Caches transport clients by agent target config and owns their lifecycle. */
@injectable()
export class AgentClientRegistry {
  private readonly clients = new Map<string, AgentClient>();

  /** Receives the factory used to create and stop protocol-specific clients. */
  constructor(
    @inject(AgentClientFactory)
    private readonly agentClientFactory: AgentClientFactory,
  ) {}

  /** Ensures the cache has a started client for the current agent snapshot. */
  async upsert(
    agent: AgentConfigSnapshot,
    previous?: AgentConfigSnapshot,
  ): Promise<void> {
    const previousKey = previous ? agentClientCacheKey(previous) : undefined;
    const nextKey = agentClientCacheKey(agent);
    const previousClient = previousKey
      ? this.clients.get(previousKey)
      : undefined;

    if (
      previous &&
      previous.protocol === agent.protocol &&
      JSON.stringify(previous.config) === JSON.stringify(agent.config) &&
      previousClient
    ) {
      return;
    }

    if (previousClient && previousKey) {
      this.clients.delete(previousKey);
      await this.agentClientFactory.stop(previousClient);
    }

    if (this.clients.has(nextKey)) {
      return;
    }

    const client = this.agentClientFactory.create(agent);
    this.clients.set(nextKey, client);
    await this.agentClientFactory.start(client);
  }

  /** Stops and removes the client registered for an agent config. */
  async remove(agent: AgentConfigSnapshot): Promise<void> {
    const key = agentClientCacheKey(agent);
    const client = this.clients.get(key);
    if (!client) {
      return;
    }

    this.clients.delete(key);
    await this.agentClientFactory.stop(client);
  }

  /** Returns the cached client for an agent or throws if it has not been registered. */
  require(agent: AgentConfigSnapshot): AgentClient {
    const client = this.clients.get(agentClientCacheKey(agent));
    if (!client) {
      throw new Error(`Agent client for ${agent.id} is not registered`);
    }

    return client;
  }

  /** Stops all cached clients and clears the registry during runtime shutdown. */
  async stopAll(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await this.agentClientFactory.stopAll(clients);
  }
}

function agentClientCacheKey(agent: AgentConfigSnapshot): string {
  return JSON.stringify({
    protocol: agent.protocol ?? "a2a",
    config: agent.config,
  });
}
