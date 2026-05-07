import {
  SessionKey,
  type ChannelMessageRecord,
  type ChannelMessageRepository,
  type MessageDirection,
} from "@agent-relay/domain";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

function mapMessageRow(row: {
  id: string;
  channelBindingId: string;
  direction: string;
  channelType: string;
  accountId: string;
  sessionKey: string;
  content: string;
  metadata: string;
  createdAt: Date;
}): ChannelMessageRecord {
  return {
    id: row.id,
    channelBindingId: row.channelBindingId,
    direction: parseDirection(row.direction),
    channelType: row.channelType,
    accountId: row.accountId,
    sessionKey: SessionKey.fromString(row.sessionKey),
    content: row.content,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Prisma-backed append-only channel message repository. */
@injectable()
export class ChannelMessageStateRepository implements ChannelMessageRepository {
  async append(record: ChannelMessageRecord): Promise<ChannelMessageRecord> {
    const row = await prisma.message.create({
      data: {
        ...(record.id ? { id: record.id } : {}),
        channelBindingId: record.channelBindingId,
        direction: record.direction,
        channelType: record.channelType,
        accountId: record.accountId,
        sessionKey: record.sessionKey.toString(),
        content: record.content,
        metadata: JSON.stringify(record.metadata ?? {}),
        ...(record.createdAt ? { createdAt: new Date(record.createdAt) } : {}),
      },
    });

    return mapMessageRow(row);
  }

  async listRecent(query: {
    channelBindingId?: string;
    limit?: number;
  } = {}): Promise<ChannelMessageRecord[]> {
    const rows = await prisma.message.findMany({
      where: query.channelBindingId
        ? { channelBindingId: query.channelBindingId }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });

    return rows.map(mapMessageRow);
  }
}

function parseDirection(value: string): MessageDirection {
  return value === "output" ? "output" : "input";
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to an empty metadata object for corrupt rows.
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
