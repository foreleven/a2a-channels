import { injectable, multiInject } from "inversify";
import type { AgentTransportFactory } from "@agent-relay/agent-transport";
import { AgentClient, TransportRegistry } from "@agent-relay/agent-transport";
import type { AgentConfigSnapshot } from "@agent-relay/domain";

import { AgentTransportToken } from "./transport-tokens.js";

/** Creates runtime agent client handles from registered transport implementations. */
@injectable()
export class AgentClientFactory {
  private readonly transportRegistry = new TransportRegistry();

  /** Registers all injected transport implementations by protocol. */
  constructor(
    @multiInject(AgentTransportToken)
    transports: AgentTransportFactory[],
  ) {
    for (const transport of transports) {
      this.transportRegistry.register(transport);
    }
  }

  /** Creates an agent client for the configured agent transport. */
  create(agent: AgentConfigSnapshot): AgentClient {
    const factory = this.transportRegistry.resolve(agent.protocol);
    const transport = factory.create(agent.config, { agentName: agent.name });

    return new AgentClient({
      protocol: agent.protocol,
      transport,
    });
  }

  /** Starts a client when its transport exposes startup work. */
  async start(client: AgentClient): Promise<void> {
    await client.start();
  }

  /** Stops a client when its transport exposes cleanup work. */
  async stop(client: AgentClient): Promise<void> {
    await client.stop();
  }

  /** Stops a set of clients concurrently during registry cleanup. */
  async stopAll(clients: Iterable<AgentClient>): Promise<void> {
    await Promise.all(Array.from(clients, (client) => this.stop(client)));
  }
}
