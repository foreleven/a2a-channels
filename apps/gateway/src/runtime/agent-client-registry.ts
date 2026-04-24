import { inject, injectable } from "inversify";
import type { AgentClientHandle } from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentClientFactory } from "./agent-clients.js";

/** Caches transport clients by agent URL and owns their lifecycle. */
@injectable()
export class AgentClientRegistry {
  private readonly clients = new Map<string, AgentClientHandle>();

  constructor(
    @inject(AgentClientFactory)
    private readonly agentClientFactory: AgentClientFactory,
  ) {}

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

  async remove(agent: AgentConfigSnapshot): Promise<void> {
    const client = this.clients.get(agent.url);
    if (!client) {
      return;
    }

    this.clients.delete(agent.url);
    await this.agentClientFactory.stop(client);
  }

  require(agent: AgentConfigSnapshot): AgentClientHandle {
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
