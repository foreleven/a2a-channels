/**
 * EventSourcedAgentConfigRepository
 *
 * Loads AgentConfigAggregate instances by replaying their event stream.
 * `findAll()` delegates to Prisma (the read projection) for efficiency and
 * returns snapshots – NOT aggregates – avoiding the incorrect-version problem
 * that would arise if those objects were later saved.
 */

import { randomUUID } from "node:crypto";

import type { AgentConfigRepository, AgentConfigSnapshot } from "@a2a-channels/domain";
import { AgentConfigAggregate } from "@a2a-channels/domain";
import type { AgentEvent } from "@a2a-channels/domain";
import type { EventStore } from "@a2a-channels/event-store";

import type { DomainEventBus } from "../domain/event-bus.js";
import { prisma } from "../store/prisma.js";

function streamId(agentId: string): string {
  return `AgentConfig:${agentId}`;
}

function mapPrismaRowToSnapshot(row: {
  id: string;
  name: string;
  url: string;
  protocol: string;
  description: string | null;
  createdAt: Date;
}): AgentConfigSnapshot {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    protocol: row.protocol,
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
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

  async findAll(): Promise<AgentConfigSnapshot[]> {
    const rows = await prisma.agent.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPrismaRowToSnapshot);
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
