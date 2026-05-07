import {
  type CreateScheduledJobData,
  type ScheduledJobRecord,
  type ScheduledJobRepository,
  type UpdateScheduledJobData,
} from "@agent-relay/domain";
import { injectable } from "inversify";

import { Prisma } from "../generated/prisma/index.js";
import { prisma } from "../store/prisma.js";

function mapJobRow(row: {
  id: string;
  name: string;
  channelBindingId: string;
  sessionKey: string;
  prompt: string;
  cronExpression: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ScheduledJobRecord {
  return {
    id: row.id,
    name: row.name,
    channelBindingId: row.channelBindingId,
    sessionKey: row.sessionKey,
    prompt: row.prompt,
    cronExpression: row.cronExpression,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Prisma-backed CRUD repository for scheduled job definitions. */
@injectable()
export class ScheduledJobStateRepository implements ScheduledJobRepository {
  async findById(id: string): Promise<ScheduledJobRecord | null> {
    const row = await prisma.scheduledJob.findUnique({ where: { id } });
    return row ? mapJobRow(row) : null;
  }

  async findAll(): Promise<ScheduledJobRecord[]> {
    const rows = await prisma.scheduledJob.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapJobRow);
  }

  async create(data: CreateScheduledJobData): Promise<ScheduledJobRecord> {
    const row = await prisma.scheduledJob.create({
      data: {
        name: data.name,
        channelBindingId: data.channelBindingId,
        sessionKey: data.sessionKey,
        prompt: data.prompt,
        cronExpression: data.cronExpression,
        enabled: data.enabled ?? true,
      },
    });
    return mapJobRow(row);
  }

  async update(
    id: string,
    data: UpdateScheduledJobData,
  ): Promise<ScheduledJobRecord | null> {
    try {
      const row = await prisma.scheduledJob.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.channelBindingId !== undefined
            ? { channelBindingId: data.channelBindingId }
            : {}),
          ...(data.sessionKey !== undefined
            ? { sessionKey: data.sessionKey }
            : {}),
          ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
          ...(data.cronExpression !== undefined
            ? { cronExpression: data.cronExpression }
            : {}),
          ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        },
      });
      return mapJobRow(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return null;
      }
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.scheduledJob.delete({ where: { id } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return false;
      }
      throw err;
    }
  }
}
