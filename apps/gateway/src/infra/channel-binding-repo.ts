/**
 * EventSourcedChannelBindingRepository
 *
 * Loads ChannelBindingAggregate instances by replaying their event stream.
 * Saves them by appending pending events to the EventStore and publishing
 * those events on the DomainEventBus.
 *
 * `findAll()` and `findEnabled()` delegate to Prisma (the read projection)
 * for efficiency and return snapshots, NOT aggregates – avoiding the
 * incorrect-version problem that would arise if those objects were saved.
 */

import { randomUUID } from "node:crypto";

import type { ChannelBindingRepository, ChannelBindingSnapshot } from "@a2a-channels/domain";
import { ChannelBindingAggregate } from "@a2a-channels/domain";
import type { ChannelBindingEvent } from "@a2a-channels/domain";
import type { EventStore } from "@a2a-channels/event-store";

import type { DomainEventBus } from "../domain/event-bus.js";
import { prisma } from "../store/prisma.js";

function streamId(bindingId: string): string {
  return `ChannelBinding:${bindingId}`;
}

function mapPrismaRowToSnapshot(row: {
  id: string;
  name: string;
  channelType: string;
  accountId: string;
  channelConfig: string;
  agentUrl: string;
  enabled: boolean;
  createdAt: Date;
}): ChannelBindingSnapshot {
  return {
    id: row.id,
    name: row.name,
    channelType: row.channelType,
    accountId: row.accountId,
    channelConfig: JSON.parse(row.channelConfig) as Record<string, unknown>,
    agentUrl: row.agentUrl,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export class EventSourcedChannelBindingRepository
  implements ChannelBindingRepository
{
  constructor(
    private readonly eventStore: EventStore,
    private readonly eventBus: DomainEventBus,
  ) {}

  async findById(id: string): Promise<ChannelBindingAggregate | null> {
    const events = await this.eventStore.load(streamId(id));
    if (events.length === 0) return null;
    const domainEvents = events.map((e) => e.payload as ChannelBindingEvent);
    const agg = ChannelBindingAggregate.reconstitute(domainEvents);
    if (agg.isDeleted) return null;
    return agg;
  }

  async findAll(): Promise<ChannelBindingSnapshot[]> {
    const rows = await prisma.channelBinding.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPrismaRowToSnapshot);
  }

  async findEnabled(
    channelType: string,
    accountId: string,
    excludeId?: string,
  ): Promise<ChannelBindingSnapshot | null> {
    const row = await prisma.channelBinding.findFirst({
      where: {
        channelType,
        accountId,
        enabled: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return row ? mapPrismaRowToSnapshot(row) : null;
  }

  async save(aggregate: ChannelBindingAggregate): Promise<void> {
    const pending = aggregate.pendingEvents;
    if (pending.length === 0) return;

    const sid = streamId(aggregate.id);
    const baseVersion = aggregate.version - pending.length;

    const newEvents = pending.map((event, i) => ({
      id: randomUUID(),
      streamId: sid,
      streamVersion: baseVersion + i + 1,
      eventType: event.eventType,
      payload: event,
      metadata: {},
      occurredAt: new Date(event.occurredAt),
    }));

    await this.eventStore.append(sid, newEvents, baseVersion);
    aggregate.clearPendingEvents();

    for (const event of pending) {
      this.eventBus.publish(event);
    }
  }
}
