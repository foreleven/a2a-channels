import { injectable, multiInject } from "inversify";
import type {
  AgentClientHandle,
  AgentTransport,
} from "@a2a-channels/agent-transport";
import { TransportRegistry } from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

import { AgentTransportToken } from "./transport-tokens.js";

/** Creates runtime agent client handles from registered transport implementations. */
@injectable()
export class AgentClientFactory {
  private readonly transportRegistry = new TransportRegistry();

  /** Registers all injected transport implementations by protocol. */
  constructor(
    @multiInject(AgentTransportToken)
    transports: AgentTransport[],
  ) {
    for (const transport of transports) {
      this.transportRegistry.register(transport);
    }
  }

  /** Creates a lightweight agent client handle for the configured agent transport. */
  create(agent: AgentConfigSnapshot): AgentClientHandle {
    const transport = this.transportRegistry.resolve(
      agent.protocol ?? "a2a",
    );

    return {
      agentUrl: agent.url,
      protocol: agent.protocol ?? transport.protocol,
      send: (request) => transport.send(agent.url, request),
    };
  }

  /** Starts a client when its transport exposes startup work. */
  async start(client: AgentClientHandle): Promise<void> {
    await client.start?.();
  }

  /** Stops a client when its transport exposes cleanup work. */
  async stop(client: AgentClientHandle): Promise<void> {
    await client.stop?.();
  }

  /** Stops a set of clients concurrently during registry cleanup. */
  async stopAll(clients: Iterable<AgentClientHandle>): Promise<void> {
    await Promise.all(Array.from(clients, (client) => this.stop(client)));
  }
}
