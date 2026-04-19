/**
 * PrismaEventStore – SQLite-backed EventStore implementation.
 *
 * Uses the `events` Prisma model.  Append operations are wrapped in a
 * transaction and include an optimistic concurrency check by verifying the
 * current maximum streamVersion before inserting.
 */

import type {
  EventStore,
  NewStoredEvent,
  StoredEvent,
} from "@a2a-channels/event-store";
import { ConcurrencyError } from "@a2a-channels/event-store";

import { prisma } from "../store/prisma.js";

function mapRow(row: {
  seq: number;
  uuid: string;
  streamId: string;
  streamVersion: number;
  eventType: string;
  payload: string;
  metadata: string;
  occurredAt: Date;
}): StoredEvent {
  return {
    id: row.uuid,
    streamId: row.streamId,
    streamVersion: row.streamVersion,
    eventType: row.eventType,
    payload: JSON.parse(row.payload) as unknown,
    metadata: JSON.parse(row.metadata) as { occurredAt: string; causedBy?: string },
    globalSeq: row.seq,
  };
}

export class PrismaEventStore implements EventStore {
  async append(
    streamId: string,
    events: NewStoredEvent[],
    expectedVersion: number,
  ): Promise<void> {
    if (events.length === 0) return;

    await prisma.$transaction(async (tx) => {
      const maxVersion = await tx.event.aggregate({
        _max: { streamVersion: true },
        where: { streamId },
      });
      const actualVersion = maxVersion._max.streamVersion ?? 0;

      if (actualVersion !== expectedVersion) {
        throw new ConcurrencyError(streamId, expectedVersion, actualVersion);
      }

      await tx.event.createMany({
        data: events.map((e) => ({
          uuid: e.id,
          streamId: e.streamId,
          streamVersion: e.streamVersion,
          eventType: e.eventType,
          payload: JSON.stringify(e.payload),
          metadata: JSON.stringify(e.metadata),
          occurredAt: e.occurredAt,
        })),
      });
    });
  }

  async load(streamId: string): Promise<StoredEvent[]> {
    const rows = await prisma.event.findMany({
      where: { streamId },
      orderBy: { streamVersion: "asc" },
    });
    return rows.map(mapRow);
  }

  async *loadAll(afterGlobalSeq = 0): AsyncIterable<StoredEvent> {
    const PAGE_SIZE = 200;
    let cursor = afterGlobalSeq;

    while (true) {
      const rows = await prisma.event.findMany({
        where: { seq: { gt: cursor } },
        orderBy: { seq: "asc" },
        take: PAGE_SIZE,
      });

      for (const row of rows) {
        yield mapRow(row);
      }

      if (rows.length < PAGE_SIZE) break;
      const lastRow = rows[rows.length - 1];
      if (!lastRow) break;
      cursor = lastRow.seq;
    }
  }
}
