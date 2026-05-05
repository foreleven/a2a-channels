import { injectable, multiInject } from "inversify";
import type {
  ACPStdioAgentConfig,
  AgentTransportFactory,
} from "@a2a-channels/agent-transport";
import { AgentClient, TransportRegistry } from "@a2a-channels/agent-transport";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";

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
    const config = injectAgentName(agent);
    const transport = factory.create(config);

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

/**
 * For ACP stdio agents, merges the agent's display name into the transport
 * config so the process isolation layer can derive per-account working
 * directories as `${ACP_BASE_PATH}/{name}/{accountId}`.
 *
 * If the persisted config already carries a `name` value it takes precedence
 * over the agent's display name, allowing an operator to choose a different
 * workspace directory name without renaming the agent.
 */
function injectAgentName(agent: AgentConfigSnapshot): typeof agent.config {
  if (agent.protocol !== "acp") return agent.config;
  const config = agent.config as ACPStdioAgentConfig;
  if (config.name) return config;
  return { ...config, name: agent.name };
}
