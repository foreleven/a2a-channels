import { inject, injectable } from "inversify";
import type { AgentClientHandle, AgentConfig } from "@a2a-channels/core";

import { TransportRegistryAssembler } from "./transport-registry-assembler.js";

@injectable()
export class AgentClientFactory {
  constructor(
    @inject(TransportRegistryAssembler)
    private readonly transportRegistryAssembler: TransportRegistryAssembler,
  ) {}

  create(agent: AgentConfig): AgentClientHandle {
    const transport = this.transportRegistryAssembler.transportRegistry.resolve(
      agent.protocol ?? "a2a",
    );

    return {
      agentUrl: agent.url,
      protocol: agent.protocol ?? transport.protocol,
      send: (request) => transport.send(agent.url, request),
    };
  }

  async start(client: AgentClientHandle): Promise<void> {
    await client.start?.();
  }

  async stop(client: AgentClientHandle): Promise<void> {
    await client.stop?.();
  }

  async stopAll(clients: Iterable<AgentClientHandle>): Promise<void> {
    await Promise.all(Array.from(clients, (client) => this.stop(client)));
  }
}
