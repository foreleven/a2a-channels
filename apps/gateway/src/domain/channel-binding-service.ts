/**
 * ChannelBindingService – application service (command handler) for channel bindings.
 *
 * Orchestrates:
 *   1. Business invariant checks (duplicate enabled bindings).
 *   2. Aggregate creation / mutation.
 *   3. Persistence via the repository (which also publishes domain events).
 *
 * This replaces the previous direct-Prisma service functions in
 * `apps/gateway/src/services/channel-bindings.ts`.
 */

import { randomUUID } from "node:crypto";

import { ChannelBindingAggregate } from "@a2a-channels/domain";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { ChannelBindingRepository } from "@a2a-channels/domain";

import { DuplicateEnabledBindingError } from "../services/channel-bindings.js";

export { DuplicateEnabledBindingError };

/** Re-exported so the HTTP layer has a single import source. */
export type { ChannelBindingSnapshot };

export type CreateChannelBindingData = Omit<ChannelBindingSnapshot, "id" | "createdAt">;
export type UpdateChannelBindingData = Partial<Omit<ChannelBindingSnapshot, "id" | "createdAt">>;

export class ChannelBindingService {
  constructor(
    private readonly repo: ChannelBindingRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Queries (read from projection via repo.findAll / findById)
  // -------------------------------------------------------------------------

  async list(): Promise<ChannelBindingSnapshot[]> {
    const all = await this.repo.findAll();
    return all.map((a) => a.snapshot());
  }

  async getById(id: string): Promise<ChannelBindingSnapshot | null> {
    const agg = await this.repo.findById(id);
    return agg ? agg.snapshot() : null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async create(data: CreateChannelBindingData): Promise<ChannelBindingSnapshot> {
    await this.assertNoDuplicateEnabled(
      data.channelType,
      data.accountId,
      data.enabled,
    );

    const agg = ChannelBindingAggregate.create({ id: randomUUID(), ...data });
    await this.repo.save(agg);
    return agg.snapshot();
  }

  async update(
    id: string,
    changes: UpdateChannelBindingData,
  ): Promise<ChannelBindingSnapshot | null> {
    const agg = await this.repo.findById(id);
    if (!agg) return null;

    // Check the duplicate invariant only when enabled/channelType/accountId changes.
    const effectiveEnabled = changes.enabled ?? agg.enabled;
    const effectiveChannelType = changes.channelType ?? agg.channelType;
    const effectiveAccountId = changes.accountId ?? agg.accountId;

    await this.assertNoDuplicateEnabled(
      effectiveChannelType,
      effectiveAccountId,
      effectiveEnabled,
      id,
    );

    agg.update(changes);
    await this.repo.save(agg);
    return agg.snapshot();
  }

  async delete(id: string): Promise<boolean> {
    const agg = await this.repo.findById(id);
    if (!agg) return false;

    agg.delete();
    await this.repo.save(agg);
    return true;
  }

  // -------------------------------------------------------------------------
  // Invariant helpers
  // -------------------------------------------------------------------------

  private async assertNoDuplicateEnabled(
    channelType: string,
    accountId: string,
    enabled: boolean,
    excludeId?: string,
  ): Promise<void> {
    if (!enabled) return;
    const existing = await this.repo.findEnabled(channelType, accountId, excludeId);
    if (existing) {
      throw new DuplicateEnabledBindingError(channelType, accountId);
    }
  }
}
