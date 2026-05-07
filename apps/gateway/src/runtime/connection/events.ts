import type { ChannelBindingSnapshot } from "@agent-relay/domain";
import type {
  MessageInboundEvent,
  MessageOutboundEvent,
} from "@agent-relay/openclaw-compat";

import type { ConnectionStatus } from "./connection-status.js";

type ChannelBinding = ChannelBindingSnapshot;

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
  emitMessageInbound?: (event: MessageInboundEvent) => void;
  emitMessageOutbound?: (event: MessageOutboundEvent) => void;
}
