/**
 * AgentService – application service for Agent configuration use-cases.
 */

import { randomUUID } from "node:crypto";
import {
  AgentConfigAggregate,
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";
import { inject, injectable } from "inversify";

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
  ) {}

  async list(): Promise<AgentConfigSnapshot[]> {
    return this.repo.findAll();
  }

  async getById(id: string): Promise<AgentConfigSnapshot | null> {
    const aggregate = await this.repo.findById(id);
    return aggregate ? aggregate.snapshot() : null;
  }

  async register(data: RegisterAgentData): Promise<AgentConfigSnapshot> {
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

    aggregate.update(changes);
    await this.repo.save(aggregate);
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
}
