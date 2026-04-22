import { injectable } from "inversify";
import type {
  AgentClientHandle,
} from "@a2a-channels/core";
import type {
  MessageInboundEvent,
  MessageOutboundEvent,
  OpenClawPluginHost,
} from "@a2a-channels/openclaw-compat";

import {
  ConnectionManager,
  type ConnectionManagerCallbacks,
} from "../connection-manager.js";

export interface ConnectionManagerProviderOptions {
  host: OpenClawPluginHost;
  getAgentClient: (
    agentId: string,
  ) => { client: AgentClientHandle; url: string } | Promise<{
    client: AgentClientHandle;
    url: string;
  }>;
  emitMessageInbound?: (event: MessageInboundEvent) => void;
  emitMessageOutbound?: (event: MessageOutboundEvent) => void;
  callbacks?: ConnectionManagerCallbacks;
}

@injectable()
export class ConnectionManagerProvider {
  create(options: ConnectionManagerProviderOptions): ConnectionManager {
    return new ConnectionManager(
      options.host,
      options.getAgentClient,
      options.emitMessageInbound,
      options.emitMessageOutbound,
      options.callbacks ?? {},
    );
  }
}
