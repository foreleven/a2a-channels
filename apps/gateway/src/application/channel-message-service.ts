import {
  ChannelMessageRepository,
  type ChannelMessageRecord,
  type ChannelMessageRepository as ChannelMessageRepositoryPort,
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";

const DEFAULT_MESSAGE_LIMIT = 25;
const MAX_MESSAGE_LIMIT = 100;

export interface ListChannelMessagesOptions {
  channelBindingId?: string;
  limit?: number;
}

/** Read model service for channel message monitoring. */
@injectable()
export class ChannelMessageService {
  constructor(
    @inject(ChannelMessageRepository)
    private readonly repo: ChannelMessageRepositoryPort,
  ) {}

  async listRecent(
    options: ListChannelMessagesOptions = {},
  ): Promise<ChannelMessageRecord[]> {
    return this.repo.listRecent({
      channelBindingId: options.channelBindingId,
      limit: normalizeLimit(options.limit),
    });
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_LIMIT;
  }

  return Math.min(MAX_MESSAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}
