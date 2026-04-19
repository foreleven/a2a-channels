/**
 * AgentConfigProjection – maintains the `agents` Prisma table as a read model
 * by consuming domain events from the bus.
 *
 * On startup, `catchUp()` replays any missed events from the event log.
 */

import type {
  AgentDeleted,
  AgentRegistered,
  AgentUpdated,
} from "@a2a-channels/domain";
import type { EventStore } from "@a2a-channels/event-store";

import type { DomainEventBus } from "../domain/event-bus.js";
import { prisma } from "../store/prisma.js";

const PROJECTION_NAME = "AgentConfigProjection";

export class AgentConfigProjection {
  constructor(
    private readonly eventBus: DomainEventBus,
    private readonly eventStore: EventStore,
  ) {}

  register(): void {
    this.eventBus.on("AgentRegistered.v1", (e) => {
      void this.onRegistered(e);
    });
    this.eventBus.on("AgentUpdated.v1", (e) => {
      void this.onUpdated(e);
    });
    this.eventBus.on("AgentDeleted.v1", (e) => {
      void this.onDeleted(e);
    });
  }

  async catchUp(): Promise<void> {
    const checkpoint = await prisma.projectionCheckpoint.upsert({
      where: { name: PROJECTION_NAME },
      create: { name: PROJECTION_NAME, seq: 0 },
      update: {},
    });

    let lastSeq = checkpoint.seq;

    for await (const stored of this.eventStore.loadAll(lastSeq)) {
      if (stored.eventType === "AgentRegistered.v1") {
        await this.onRegistered(stored.payload as AgentRegistered);
      } else if (stored.eventType === "AgentUpdated.v1") {
        await this.onUpdated(stored.payload as AgentUpdated);
      } else if (stored.eventType === "AgentDeleted.v1") {
        await this.onDeleted(stored.payload as AgentDeleted);
      }
      lastSeq = stored.globalSeq;
    }

    if (lastSeq !== checkpoint.seq) {
      await prisma.projectionCheckpoint.update({
        where: { name: PROJECTION_NAME },
        data: { seq: lastSeq },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async onRegistered(e: AgentRegistered): Promise<void> {
    await prisma.agent.upsert({
      where: { id: e.agentId },
      create: {
        id: e.agentId,
        name: e.name,
        url: e.url,
        protocol: e.protocol,
        description: e.description ?? null,
        createdAt: new Date(e.occurredAt),
      },
      update: {
        name: e.name,
        url: e.url,
        protocol: e.protocol,
        description: e.description ?? null,
      },
    });
  }

  private async onUpdated(e: AgentUpdated): Promise<void> {
    const c = e.changes;
    await prisma.agent.updateMany({
      where: { id: e.agentId },
      data: {
        ...(c.name !== undefined && { name: c.name }),
        ...(c.url !== undefined && { url: c.url }),
        ...(c.protocol !== undefined && { protocol: c.protocol }),
        ...("description" in c && { description: c.description }),
      },
    });
  }

  private async onDeleted(e: AgentDeleted): Promise<void> {
    await prisma.agent.deleteMany({ where: { id: e.agentId } });
  }
}
