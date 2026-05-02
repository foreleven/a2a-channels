/**
 * ChannelBindingService – application service for channel binding use-cases.
 */

import { randomUUID } from "node:crypto";
import {
  AgentConfigRepository,
  ChannelBindingAggregate,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import { inject, injectable } from "inversify";

import {
  RuntimeEventBus,
  type RuntimeEventBus as RuntimeEventBusType,
} from "../runtime/event-transport/runtime-event-bus.js";
import { AgentNotFoundError, DuplicateEnabledBindingError } from "./errors.js";

export { AgentNotFoundError, DuplicateEnabledBindingError };
export type { ChannelBindingSnapshot };
export type CreateChannelBindingData = Omit<
  ChannelBindingSnapshot,
  "id" | "createdAt"
>;
export type UpdateChannelBindingData = Partial<
  Omit<ChannelBindingSnapshot, "id" | "createdAt">
>;

/**
 * Application service for ChannelBinding commands and queries.
 *
 * It enforces application-level cross-aggregate checks before delegating state
 * transitions to ChannelBindingAggregate.
 */
@injectable()
export class ChannelBindingService {
  constructor(
    @inject(ChannelBindingRepository)
    private readonly repo: ChannelBindingRepository,
    @inject(AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
    @inject(RuntimeEventBus)
    private readonly eventBus: RuntimeEventBusType,
  ) {}

  async list(): Promise<ChannelBindingSnapshot[]> {
    return this.repo.findAll();
  }

  async getById(id: string): Promise<ChannelBindingSnapshot | null> {
    const aggregate = await this.repo.findById(id);
    return aggregate ? aggregate.snapshot() : null;
  }

  async create(data: CreateChannelBindingData): Promise<ChannelBindingSnapshot> {
    await this.assertAgentExists(data.agentId);
    await this.assertNoDuplicateEnabled(
      data.channelType,
      data.accountId,
      data.enabled,
    );

    const aggregate = ChannelBindingAggregate.create({
      id: randomUUID(),
      ...data,
    });
    await this.repo.save(aggregate);
    void this.eventBus
      .broadcast({ type: "BindingChanged", bindingId: aggregate.snapshot().id })
      .catch((err) =>
        console.error("[binding-service] failed to broadcast BindingChanged:", err),
      );
    return aggregate.snapshot();
  }

  async update(
    id: string,
    changes: UpdateChannelBindingData,
  ): Promise<ChannelBindingSnapshot | null> {
    const aggregate = await this.repo.findById(id);
    if (!aggregate) {
      return null;
    }

    const effectiveEnabled = changes.enabled ?? aggregate.enabled;
    const effectiveChannelType = changes.channelType ?? aggregate.channelType;
    const effectiveAccountId = changes.accountId ?? aggregate.accountId;
    const effectiveAgentId = changes.agentId ?? aggregate.agentId;

    await this.assertAgentExists(effectiveAgentId);
    await this.assertNoDuplicateEnabled(
      effectiveChannelType,
      effectiveAccountId,
      effectiveEnabled,
      id,
    );

    aggregate.update(changes);
    await this.repo.save(aggregate);
    void this.eventBus
      .broadcast({ type: "BindingChanged", bindingId: id })
      .catch((err) =>
        console.error("[binding-service] failed to broadcast BindingChanged:", err),
      );
    return aggregate.snapshot();
  }

  async delete(id: string): Promise<boolean> {
    const aggregate = await this.repo.findById(id);
    if (!aggregate) {
      return false;
    }

    aggregate.delete();
    await this.repo.save(aggregate);
    void this.eventBus
      .broadcast({ type: "BindingChanged", bindingId: id })
      .catch((err) =>
        console.error("[binding-service] failed to broadcast BindingChanged:", err),
      );
    return true;
  }

  private async assertAgentExists(agentId: string): Promise<void> {
    const agent = await this.agentRepo.findById(agentId);
    if (!agent) {
      throw new AgentNotFoundError(agentId);
    }
  }

  private async assertNoDuplicateEnabled(
    channelType: string,
    accountId: string,
    enabled: boolean,
    excludeId?: string,
  ): Promise<void> {
    if (!enabled) {
      return;
    }

    const existing = await this.repo.findEnabled(channelType, accountId, excludeId);
    if (existing) {
      throw new DuplicateEnabledBindingError(channelType, accountId);
    }
  }
}
