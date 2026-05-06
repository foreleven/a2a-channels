/**
 * AgentService – application service for Agent configuration use-cases.
 */

import { randomUUID } from "node:crypto";
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
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";

import {
  RuntimeEventBus,
  type RuntimeEventBus as RuntimeEventBusType,
} from "../runtime/event-transport/runtime-event-bus.js";

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
    assertProtocolConfig(data.protocol, data.config);
    const aggregate = AgentConfigAggregate.register({
      id: randomUUID(),
      ...data,
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
    const nextConfig = changes.config ?? current.config;
    assertProtocolConfig(nextProtocol, nextConfig);

    aggregate.update(changes);
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
        console.error("[agent-service] failed to broadcast AgentChanged:", err),
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

  if (!("transport" in config)) {
    throw new InvalidAgentConfigError("ACP agent config requires transport");
  }
}
