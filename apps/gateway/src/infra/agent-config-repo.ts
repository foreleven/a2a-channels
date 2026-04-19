/**
 * EventSourcedAgentConfigRepository
 *
 * Loads AgentConfigAggregate instances by replaying their event stream.
 * `findAll()` delegates to Prisma (the read projection) for efficiency.
 */

import { randomUUID } from "node:crypto";

import type { AgentConfigRepository } from "@a2a-channels/domain";
import { AgentConfigAggregate } from "@a2a-channels/domain";
import type { AgentEvent } from "@a2a-channels/domain";
import type { EventStore } from "@a2a-channels/event-store";

import type { DomainEventBus } from "../domain/event-bus.js";
import { prisma } from "../store/prisma.js";

function streamId(agentId: string): string {
  return `AgentConfig:${agentId}`;
}

function mapPrismaRow(row: {
  id: string;
  name: string;
  url: string;
  protocol: string;
  description: string | null;
  createdAt: Date;
}): AgentConfigAggregate {
  const agg = new AgentConfigAggregate();
  agg.id = row.id;
  agg.name = row.name;
  agg.url = row.url;
  agg.protocol = row.protocol;
  agg.description = row.description ?? undefined;
  agg.createdAt = row.createdAt.toISOString();
  return agg;
}

export class EventSourcedAgentConfigRepository
  implements AgentConfigRepository
{
  constructor(
    private readonly eventStore: EventStore,
    private readonly eventBus: DomainEventBus,
  ) {}

  async findById(id: string): Promise<AgentConfigAggregate | null> {
    const events = await this.eventStore.load(streamId(id));
    if (events.length === 0) return null;
    const domainEvents = events.map((e) => e.payload as AgentEvent);
    const agg = AgentConfigAggregate.reconstitute(domainEvents);
    if (agg.isDeleted) return null;
    return agg;
  }

  async findAll(): Promise<AgentConfigAggregate[]> {
    const rows = await prisma.agent.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPrismaRow);
  }

  async save(aggregate: AgentConfigAggregate): Promise<void> {
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
      metadata: { occurredAt: event.occurredAt },
      occurredAt: new Date(event.occurredAt),
    }));

    await this.eventStore.append(sid, newEvents, baseVersion);
    aggregate.clearPendingEvents();

    for (const event of pending) {
      this.eventBus.publish(event);
    }
  }
}
