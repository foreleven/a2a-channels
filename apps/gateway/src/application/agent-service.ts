/**
 * AgentService – application service for Agent configuration use-cases.
 */

import { randomUUID, randomBytes } from "node:crypto";
import {
  AgentConfigAggregate,
  AgentConfigRepository,
  ChannelBindingRepository,
  isValidAgentName,
} from "@agent-relay/domain";
import type {
  AgentConfigSnapshot,
  AgentProtocol,
  AgentProtocolConfig,
  WsTunnelAgentConfig,
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";

import {
  RuntimeEventBus,
  type RuntimeEventBus as RuntimeEventBusType,
} from "../runtime/event-transport/runtime-event-bus.js";
import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../infra/logger.js";

export type { AgentConfigSnapshot };
export type RegisterAgentData = Omit<AgentConfigSnapshot, "id" | "createdAt">;
export type UpdateAgentData = Partial<
  Omit<AgentConfigSnapshot, "id" | "createdAt">
>;

/** Raised when deleting an Agent would leave existing bindings orphaned. */
export class ReferencedAgentError extends Error {
  constructor(
    readonly agentId: string,
    readonly bindingIds: string[],
  ) {
    super(`Agent ${agentId} is referenced by ${bindingIds.length} channel binding(s)`);
  }
}

export class InvalidAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Application service for Agent configuration commands and queries.
 *
 * It orchestrates repositories and AgentConfigAggregate methods, keeping HTTP
 * route handlers free of domain mutation details.
 */
@injectable()
export class AgentService {
  constructor(
    @inject(AgentConfigRepository)
    private readonly repo: AgentConfigRepository,
    @inject(ChannelBindingRepository)
    private readonly bindingRepo: ChannelBindingRepository,
    @inject(RuntimeEventBus)
    private readonly eventBus: RuntimeEventBusType,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
  ) {}

  async list(): Promise<AgentConfigSnapshot[]> {
    return this.repo.findAll();
  }

  async getById(id: string): Promise<AgentConfigSnapshot | null> {
    const aggregate = await this.repo.findById(id);
    return aggregate ? aggregate.snapshot() : null;
  }

  async register(data: RegisterAgentData): Promise<AgentConfigSnapshot> {
    assertAgentName(data.name);
    const config = injectRelayTokenIfNeeded(data.protocol, data.config);
    assertProtocolConfig(data.protocol, config);
    const aggregate = AgentConfigAggregate.register({
      id: randomUUID(),
      ...data,
      config,
    });
    await this.repo.save(aggregate);
    return aggregate.snapshot();
  }

  async update(
    id: string,
    changes: UpdateAgentData,
  ): Promise<AgentConfigSnapshot | null> {
    const aggregate = await this.repo.findById(id);
    if (!aggregate) {
      return null;
    }

    const current = aggregate.snapshot();
    assertAgentName(changes.name ?? current.name);
    const nextProtocol = changes.protocol ?? current.protocol;
    const nextConfig = mergeWsTunnelConfig(
      current.protocol,
      current.config,
      nextProtocol,
      changes.config ?? current.config,
    );
    assertProtocolConfig(nextProtocol, nextConfig);

    aggregate.update({ ...changes, config: nextConfig });
    await this.repo.save(aggregate);
    this.broadcastAgentChanged(id);
    return aggregate.snapshot();
  }

  /**
   * Regenerates the relayToken for a ws-tunnel agent.
   * Returns the updated snapshot (which includes the new token) or null if
   * the agent does not exist or is not a ws-tunnel agent.
   */
  async regenerateRelayToken(id: string): Promise<AgentConfigSnapshot | null> {
    const aggregate = await this.repo.findById(id);
    if (!aggregate) {
      return null;
    }

    const current = aggregate.snapshot();
    if (current.protocol !== "ws-tunnel") {
      throw new InvalidAgentConfigError(
        `Agent ${id} is not a ws-tunnel agent; cannot regenerate relay token`,
      );
    }

    const currentConfig = current.config as WsTunnelAgentConfig;
    const newConfig: WsTunnelAgentConfig = {
      ...currentConfig,
      relayToken: generateRelayToken(),
    };

    aggregate.update({ config: newConfig });
    await this.repo.save(aggregate);
    this.broadcastAgentChanged(id);
    return aggregate.snapshot();
  }

  async delete(id: string): Promise<boolean> {
    const aggregate = await this.repo.findById(id);
    if (!aggregate) {
      return false;
    }

    const bindings = await this.bindingRepo.findByAgentId(id);
    if (bindings.length > 0) {
      throw new ReferencedAgentError(
        id,
        bindings.map((binding) => binding.id),
      );
    }

    aggregate.delete();
    await this.repo.save(aggregate);
    return true;
  }

  private broadcastAgentChanged(agentId: string): void {
    void this.eventBus
      .broadcast({ type: "AgentChanged", agentId })
      .catch((err) =>
        this.logger.error(
          { agentId, err },
          "failed to broadcast AgentChanged event",
        ),
      );
  }
}

function assertAgentName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new InvalidAgentConfigError(
      "Agent name must be a folder-safe name using only letters, numbers, dots, underscores, and hyphens",
    );
  }
}

function assertProtocolConfig(
  protocol: AgentProtocol,
  config: AgentProtocolConfig,
): void {
  if (protocol === "a2a") {
    if ("transport" in config) {
      throw new InvalidAgentConfigError(
        "A2A agent config must contain only protocol-specific URL fields",
      );
    }
    return;
  }

  if (protocol === "acp") {
    if (!("transport" in config)) {
      throw new InvalidAgentConfigError("ACP agent config requires transport");
    }
    return;
  }

  if (protocol === "ws-tunnel") {
    if (!("transport" in config) || (config as { transport?: unknown }).transport !== "ws-tunnel") {
      throw new InvalidAgentConfigError(
        "ws-tunnel agent config requires transport: 'ws-tunnel'",
      );
    }
  }
}

function generateRelayToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * For `ws-tunnel` agents, always injects a freshly generated `relayToken`
 * regardless of any value the caller supplied.  The gateway owns token
 * issuance; client-supplied values must be discarded.
 */
function injectRelayTokenIfNeeded(
  protocol: AgentProtocol,
  config: AgentProtocolConfig,
): AgentProtocolConfig {
  if (protocol !== "ws-tunnel") return config;
  // Always generate – never accept a caller-supplied token so weak/known
  // tokens cannot be injected at registration time.
  return { ...(config as WsTunnelAgentConfig), relayToken: generateRelayToken() };
}

/**
 * When updating a ws-tunnel agent, preserve the existing relayToken from the
 * stored config regardless of what the caller supplies (the dedicated
 * `regenerateRelayToken()` method is the only authorised path for rotation).
 */
function mergeWsTunnelConfig(
  currentProtocol: AgentProtocol,
  currentConfig: AgentProtocolConfig,
  nextProtocol: AgentProtocol,
  nextConfig: AgentProtocolConfig,
): AgentProtocolConfig {
  if (currentProtocol !== "ws-tunnel" || nextProtocol !== "ws-tunnel") {
    return nextConfig;
  }
  const existingToken = (currentConfig as WsTunnelAgentConfig).relayToken;
  return { ...(nextConfig as WsTunnelAgentConfig), relayToken: existingToken };
}
