/**
 * Repository interfaces for the domain layer.
 *
 * These are pure interfaces – the concrete implementations live in
 * apps/gateway/src/infra/ and depend on the event store + Prisma.
 */

import type { AgentConfigAggregate } from "./aggregates/agent-config.js";
import type { ChannelBindingAggregate } from "./aggregates/channel-binding.js";

export interface ChannelBindingRepository {
  /** Reconstruct the aggregate from its event stream. Returns null if unknown. */
  findById(id: string): Promise<ChannelBindingAggregate | null>;

  /** Load all non-deleted bindings (from the read projection). */
  findAll(): Promise<ChannelBindingAggregate[]>;

  /**
   * Find the single enabled binding for a channelType + accountId pair.
   * Used for duplicate-enabled invariant checks.
   */
  findEnabled(
    channelType: string,
    accountId: string,
    excludeId?: string,
  ): Promise<ChannelBindingAggregate | null>;

  /**
   * Persist pending domain events for the aggregate.
   * Implementations must:
   *   1. Append events to the event store (with optimistic concurrency check).
   *   2. Call aggregate.clearPendingEvents().
   *   3. Publish events to the DomainEventBus.
   */
  save(aggregate: ChannelBindingAggregate): Promise<void>;
}

export interface AgentConfigRepository {
  findById(id: string): Promise<AgentConfigAggregate | null>;
  findAll(): Promise<AgentConfigAggregate[]>;
  save(aggregate: AgentConfigAggregate): Promise<void>;
}
