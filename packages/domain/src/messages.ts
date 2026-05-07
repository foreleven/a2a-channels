export type MessageDirection = "input" | "output";

export interface ChannelMessageRecord {
  id?: string;
  channelBindingId: string;
  direction: MessageDirection;
  channelType: string;
  accountId: string;
  sessionKey: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

