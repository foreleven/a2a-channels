import { inject, injectable } from "inversify";
import type { AgentClient } from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentClientFactory } from "./agent-clients.js";

/** Caches transport clients by agent URL and owns their lifecycle. */
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
    const previousClient = previous?.url
      ? this.clients.get(previous.url)
      : undefined;

    if (
      previous &&
      previous.url === agent.url &&
      previous.protocol === agent.protocol &&
      previousClient
    ) {
      return;
    }

    if (previousClient && previous?.url) {
      this.clients.delete(previous.url);
      await this.agentClientFactory.stop(previousClient);
    }

    if (this.clients.has(agent.url)) {
      return;
    }

    const client = this.agentClientFactory.create(agent);
    this.clients.set(agent.url, client);
    await this.agentClientFactory.start(client);
  }

  /** Stops and removes the client registered for an agent URL. */
  async remove(agent: AgentConfigSnapshot): Promise<void> {
    const client = this.clients.get(agent.url);
    if (!client) {
      return;
    }

    this.clients.delete(agent.url);
    await this.agentClientFactory.stop(client);
  }

  /** Returns the cached client for an agent or throws if it has not been registered. */
  require(agent: AgentConfigSnapshot): AgentClient {
    const client = this.clients.get(agent.url);
    if (!client) {
      throw new Error(`Agent client for ${agent.url} is not registered`);
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
