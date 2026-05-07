import { Hono } from "hono";
import { inject, injectable } from "inversify";
import type { ChannelMessageRecord } from "@agent-relay/domain";

import { ChannelMessageService } from "../../application/channel-message-service.js";

interface ChannelMessageResponse {
  id?: string;
  channelBindingId: string;
  direction: "input" | "output";
  channelType: string;
  accountId: string;
  sessionKey: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/** HTTP adapter for channel message monitoring read APIs. */
@injectable()
export class MessageRoutes {
  constructor(
    @inject(ChannelMessageService)
    private readonly channelMessages: ChannelMessageService,
  ) {}

  register(app: Hono): void {
    app.get("/api/messages", async (c) =>
      c.json(
        (
          await this.channelMessages.listRecent({
            channelBindingId: normalizeQueryValue(
              c.req.query("channelBindingId"),
            ),
            agentId: normalizeQueryValue(c.req.query("agentId")),
            limit: parseLimit(c.req.query("limit")),
          })
        ).map(toMessageResponse),
      ),
    );
  }
}

function toMessageResponse(
  message: ChannelMessageRecord,
): ChannelMessageResponse {
  return {
    id: message.id,
    channelBindingId: message.channelBindingId,
    direction: message.direction,
    channelType: message.channelType,
    accountId: message.accountId,
    sessionKey: message.sessionKey.toString(),
    content: message.content,
    metadata: message.metadata,
    createdAt: message.createdAt,
  };
}

function normalizeQueryValue(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
