import type {
  ChannelBindingSnapshot,
  SessionKey,
} from "@agent-relay/domain";
import type { AgentFile } from "@agent-relay/agent-transport";
import type { ChannelReplyEvent } from "@agent-relay/openclaw-compat";

import type { ConnectionStatus } from "./connection-status.js";

type ChannelBinding = ChannelBindingSnapshot;

/** Gateway-owned inbound message shape after normalizing the raw OpenClaw route session. */
export interface GatewayMessageInboundEvent {
  channelType: string | undefined;
  accountId: string;
  sessionKey: SessionKey;
  userMessage: string;
  event?: ChannelReplyEvent;
  replyToId?: string;
  files?: AgentFile[];
  metadata?: Record<string, unknown>;
}

/** Gateway-owned outbound message shape that keeps the original channel session identity. */
export interface GatewayMessageOutboundEvent {
  channelType: string | undefined;
  accountId: string;
  sessionKey: SessionKey;
  replyText: string;
  metadata?: Record<string, unknown>;
}

/** Connection status event emitted when a binding lifecycle edge changes. */
export interface ConnectionLifecycleEvent {
  binding: ChannelBinding;
  status: ConnectionStatus;
  error?: unknown;
}

/** Failure event emitted when an inbound channel message cannot reach its agent. */
export interface AgentCallFailureEvent {
  binding: ChannelBinding;
  error: unknown;
}

/** Optional observers for connection state and agent dispatch failures. */
export interface ConnectionManagerCallbacks {
  onConnectionStatus?: (event: ConnectionLifecycleEvent) => void;
  onAgentCallFailed?: (event: AgentCallFailureEvent) => void;
}

/** Optional observers used by a single live binding connection. */
export interface ConnectionCallbacks extends ConnectionManagerCallbacks {
  emitMessageInbound?: (event: GatewayMessageInboundEvent) => void;
  emitMessageOutbound?: (event: GatewayMessageOutboundEvent) => void;
}
