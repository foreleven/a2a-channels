import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

export interface RuntimeNodeStateRecord {
  nodeId: string;
  displayName: string;
  mode: string;
  lastKnownAddress: string;
  registeredAt: Date;
  updatedAt: Date;
}

function mapRuntimeNodeRow(row: {
  nodeId: string;
  displayName: string;
  mode: string;
  lastKnownAddress: string;
  registeredAt: Date;
  updatedAt: Date;
}): RuntimeNodeStateRecord {
  return {
    nodeId: row.nodeId,
    displayName: row.displayName,
    mode: row.mode,
    lastKnownAddress: row.lastKnownAddress,
    registeredAt: row.registeredAt,
    updatedAt: row.updatedAt,
  };
}

/** Persists registered runtime node metadata for status queries. */
@injectable()
export class RuntimeNodeStateRepository {
  async upsert(record: RuntimeNodeStateRecord): Promise<void> {
    await prisma.runtimeNode.upsert({
      where: { nodeId: record.nodeId },
      create: {
        nodeId: record.nodeId,
        displayName: record.displayName,
        mode: record.mode,
        lastKnownAddress: record.lastKnownAddress,
        registeredAt: record.registeredAt,
        updatedAt: record.updatedAt,
      },
      update: {
        displayName: record.displayName,
        mode: record.mode,
        lastKnownAddress: record.lastKnownAddress,
        updatedAt: record.updatedAt,
      },
    });
  }

  async list(): Promise<RuntimeNodeStateRecord[]> {
    const rows = await prisma.runtimeNode.findMany({
      orderBy: { registeredAt: "asc" },
    });
    return rows.map(mapRuntimeNodeRow);
  }
}
