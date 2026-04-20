/**
 * Repository interfaces for the domain layer.
 *
 * These are pure interfaces – the concrete implementations live in
 * apps/gateway/src/infra/ and depend on the event store + Prisma.
 */

import type { AgentConfigAggregate, AgentConfigSnapshot } from "./aggregates/agent-config.js";
import type { ChannelBindingAggregate, ChannelBindingSnapshot } from "./aggregates/channel-binding.js";

export interface ChannelBindingRepository {
  /** Reconstruct the aggregate from its event stream. Returns null if unknown. */
  findById(id: string): Promise<ChannelBindingAggregate | null>;

  /**
   * Load all non-deleted bindings as snapshots (from the read projection).
   * Returns snapshots – not aggregates – since callers only need read access
   * and loading aggregates from the event stream would be wasteful for list
   * operations.
   */
  findAll(): Promise<ChannelBindingSnapshot[]>;

  /**
   * Find the single enabled binding for a channelType + accountId pair.
   * Returns a snapshot for existence checks only; never mutate and re-save.
   */
  findEnabled(
    channelType: string,
    accountId: string,
    excludeId?: string,
  ): Promise<ChannelBindingSnapshot | null>;

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
  /**
   * Load all non-deleted agents as snapshots (from the read projection).
   * Returns snapshots – not aggregates – since callers only need read access.
   */
  findAll(): Promise<AgentConfigSnapshot[]>;
  save(aggregate: AgentConfigAggregate): Promise<void>;
}
