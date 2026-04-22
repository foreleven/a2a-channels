import { inject, injectable } from "inversify";
import type {
  AgentClientHandle,
  AgentConfig,
  TransportRegistry,
} from "@a2a-channels/core";

import {
  createAgentClientHandle,
  startAgentClients,
  stopAgentClients,
} from "./agent-clients.js";
import { TransportRegistryProvider } from "./transport-registry-provider.js";

@injectable()
export class AgentClientRegistry {
  readonly transportRegistry: TransportRegistry;

  private readonly clients = new Map<string, AgentClientHandle>();

  constructor(
    @inject(TransportRegistryProvider)
    transportProvider: TransportRegistryProvider,
  ) {
    this.transportRegistry = transportProvider.transportRegistry;
  }

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
      await stopAgentClients([previousClient]);
    }

    if (this.clients.has(agent.url)) {
      return;
    }

    const client = createAgentClientHandle(
      agent,
      this.transportRegistry.resolve(agent.protocol ?? "a2a"),
    );
    this.clients.set(agent.url, client);
    await startAgentClients([client]);
  }

  async remove(agent: AgentConfig): Promise<void> {
    const client = this.clients.get(agent.url);
    if (!client) {
      return;
    }

    this.clients.delete(agent.url);
    await stopAgentClients([client]);
  }

  get(agent: AgentConfig): AgentClientHandle {
    return (
      this.clients.get(agent.url) ??
      createAgentClientHandle(
        agent,
        this.transportRegistry.resolve(agent.protocol ?? "a2a"),
      )
    );
  }

  async stopAll(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await stopAgentClients(clients);
  }
}
