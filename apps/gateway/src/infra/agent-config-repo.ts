import type { AgentConfigRepository, AgentConfigSnapshot } from "@a2a-channels/domain";
import { AgentConfigAggregate } from "@a2a-channels/domain";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

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

/** Prisma-backed current-state repository for AgentConfig aggregates. */
@injectable()
export class AgentConfigStateRepository implements AgentConfigRepository {
  async findById(id: string): Promise<AgentConfigAggregate | null> {
    const row = await prisma.agent.findUnique({ where: { id } });
    if (!row) return null;
    return AgentConfigAggregate.fromSnapshot(mapPrismaRowToSnapshot(row));
  }

  async findByUrl(url: string): Promise<AgentConfigSnapshot | null> {
    const row = await prisma.agent.findFirst({
      where: { url },
      orderBy: { createdAt: "asc" },
    });
    return row ? mapPrismaRowToSnapshot(row) : null;
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

    await prisma.$transaction(async (tx) => {
      if (aggregate.isDeleted) {
        await tx.agent.deleteMany({ where: { id: aggregate.id } });
      } else {
        const snapshot = aggregate.snapshot();
        await tx.agent.upsert({
          where: { id: snapshot.id },
          create: {
            id: snapshot.id,
            name: snapshot.name,
            url: snapshot.url,
            protocol: snapshot.protocol ?? "a2a",
            description: snapshot.description,
            createdAt: new Date(snapshot.createdAt),
          },
          update: {
            name: snapshot.name,
            url: snapshot.url,
            protocol: snapshot.protocol ?? "a2a",
            description: snapshot.description,
          },
        });
      }

    });

    aggregate.clearPendingEvents();
  }
}
