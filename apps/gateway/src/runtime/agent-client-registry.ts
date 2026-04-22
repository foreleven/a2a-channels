import { inject, injectable } from "inversify";
import type { AgentClientHandle, AgentConfig } from "@a2a-channels/core";

import { AgentClientFactory } from "./agent-clients.js";

@injectable()
export class AgentClientRegistry {
  private readonly clients = new Map<string, AgentClientHandle>();

  constructor(
    @inject(AgentClientFactory)
    private readonly agentClientFactory: AgentClientFactory,
  ) {}

  async upsert(agent: AgentConfig, previous?: AgentConfig): Promise<void> {
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

  async remove(agent: AgentConfig): Promise<void> {
    const client = this.clients.get(agent.url);
    if (!client) {
      return;
    }

    this.clients.delete(agent.url);
    await this.agentClientFactory.stop(client);
  }

  require(agent: AgentConfig): AgentClientHandle {
    const client = this.clients.get(agent.url);
    if (!client) {
      throw new Error(`Agent client for ${agent.url} is not registered`);
    }

    return client;
  }

  async stopAll(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await this.agentClientFactory.stopAll(clients);
  }
}
