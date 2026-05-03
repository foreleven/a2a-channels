import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { MessageOutboundEvent } from "@a2a-channels/openclaw-compat";

import type { ConnectionStatus } from "./connection-status.js";

type ChannelBinding = ChannelBindingSnapshot;

/** Connection status event emitted when a binding lifecycle edge changes. */
export interface ConnectionLifecycleEvent {
  binding: ChannelBinding;
  status: ConnectionStatus;
  agentUrl?: string;
  error?: unknown;
}

/** Failure event emitted when an inbound channel message cannot reach its agent. */
export interface AgentCallFailureEvent {
  binding: ChannelBinding;
  agentUrl: string;
  error: unknown;
}

/** Optional observers for connection state and agent dispatch failures. */
export interface ConnectionManagerCallbacks {
  onConnectionStatus?: (event: ConnectionLifecycleEvent) => void;
  onAgentCallFailed?: (event: AgentCallFailureEvent) => void;
}

/** Optional observers used by a single live binding connection. */
export interface ConnectionCallbacks extends ConnectionManagerCallbacks {
  emitMessageOutbound?: (event: MessageOutboundEvent) => void;
}
