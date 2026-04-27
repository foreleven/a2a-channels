/**
 * ConnectionManager – lifecycle and dispatch manager for channel bindings.
 *
 * Owns per-binding connections (binding + agent client + AbortController +
 * running Promise), starts/stops them through the plugin host, and handles
 * channel reply dispatch events by routing inbound messages through the bound
 * agent client and returning replies to the channel dispatcher.
 */

import type { AgentClientHandle } from "@a2a-channels/agent-transport";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type {
  ChannelReplyEvent,
  ChannelBindingStatusUpdate,
  MessageInboundEvent,
  MessageOutboundEvent,
  OpenClawPluginHost,
} from "@a2a-channels/openclaw-compat";
import { injectable } from "inversify";
import type { ConnectionStatus } from "./runtime-connection-status.js";

type ChannelBinding = ChannelBindingSnapshot;

/** Live connection record for one owned channel binding. */
export interface Connection {
  abortController: AbortController;
  agentClient: AgentClientHandle;
  agentUrl: string;
  binding: ChannelBinding;
  hasReportedConnected: boolean;
  promise: Promise<void>;
  suppressDisconnectStatus: boolean;
}

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

/** Runtime collaborators needed before the manager can start bindings. */
export interface ConnectionManagerOptions {
  host: OpenClawPluginHost;
  getAgentClient: (
    agentId: string,
  ) =>
    | { client: AgentClientHandle; url: string }
    | Promise<{ client: AgentClientHandle; url: string }>;
  emitMessageInbound?: (event: MessageInboundEvent) => void;
  emitMessageOutbound?: (event: MessageOutboundEvent) => void;
  callbacks?: ConnectionManagerCallbacks;
}

type ReplyDeliveryResult = {
  counts: { block: number; final: number; tool: number };
  queuedFinal: boolean;
};

/** Adapts agent reply text to the two OpenClaw reply event delivery shapes. */
class ChannelReplyDelivery {
  /** Delivers a nullable final reply and returns OpenClaw-compatible counters. */
  async deliver(
    event: ChannelReplyEvent,
    response: { text: string } | null,
  ): Promise<ReplyDeliveryResult> {
    if (event.type === "channel.reply.dispatch") {
      return this.deliverDispatchEvent(event, response);
    }

    return this.deliverBufferedEvent(event, response);
  }

  /** Completes dispatcher-based reply events after optionally sending final text. */
  private async deliverDispatchEvent(
    event: Extract<ChannelReplyEvent, { type: "channel.reply.dispatch" }>,
    response: { text: string } | null,
  ): Promise<ReplyDeliveryResult> {
    if (!response) {
      event.dispatcher.markComplete();
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }

    event.dispatcher.sendFinalReply({ text: response.text });
    await event.dispatcher.waitForIdle();
    event.dispatcher.markComplete();
    return {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    };
  }

  /** Delivers buffered reply events through their dispatcher options callback. */
  private async deliverBufferedEvent(
    event: Exclude<ChannelReplyEvent, { type: "channel.reply.dispatch" }>,
    response: { text: string } | null,
  ): Promise<ReplyDeliveryResult> {
    if (!response) {
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }

    try {
      await event.dispatcherOptions.deliver(
        { text: response.text },
        { kind: "final" },
      );
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 1 },
      };
    } catch (error) {
      event.dispatcherOptions.onError?.(error, { kind: "final" });
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }
  }
}

/** Orchestrates channel plugin connections and forwards inbound messages to agents. */
@injectable()
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly replyDelivery = new ChannelReplyDelivery();
  private host: OpenClawPluginHost | null = null;
  private getAgentClient:
    | ConnectionManagerOptions["getAgentClient"]
    | null = null;
  private emitMessageInbound?: (event: MessageInboundEvent) => void;
  private emitMessageOutbound?: (event: MessageOutboundEvent) => void;
  private callbacks: ConnectionManagerCallbacks = {};

  /** Supplies runtime collaborators after DI construction and returns the manager for chaining. */
  initialize(options: ConnectionManagerOptions): this {
    this.host = options.host;
    this.getAgentClient = options.getAgentClient;
    this.emitMessageInbound = options.emitMessageInbound;
    this.emitMessageOutbound = options.emitMessageOutbound;
    this.callbacks = options.callbacks ?? {};
    return this;
  }

  /** Creates a plugin-host connection record and reports status transitions from the host. */
  private async createConnection(binding: ChannelBinding): Promise<Connection> {
    const abortController = new AbortController();
    const target = await this.requireAgentClientFactory()(binding.agentId);
    const agentClient = target.client;

    console.log(
      `[connection] starting binding ${binding.id} for ${binding.channelType}:${binding.accountId}`,
      binding,
    );

    this.callbacks.onConnectionStatus?.({
      binding,
      status: "connecting",
      agentUrl: target.url,
    });

    let connection!: Connection;
    const maybeReportConnected = (
      status: ChannelBindingStatusUpdate,
    ): void => {
      if (connection.hasReportedConnected) {
        return;
      }

      if (status.connected !== true && status.running !== true) {
        return;
      }

      connection.hasReportedConnected = true;
      this.callbacks.onConnectionStatus?.({
        binding,
        status: "connected",
        agentUrl: target.url,
      });
    };

    const promise = Promise.resolve()
      .then(() =>
        this.requireHost().startChannelBinding(binding, abortController.signal, {
          onStatus: maybeReportConnected,
        }),
      )
      .then(() => {
        if (connection.suppressDisconnectStatus) {
          return;
        }

        this.callbacks.onConnectionStatus?.({
          binding,
          status: "disconnected",
          agentUrl: target.url,
        });
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") {
          if (connection.suppressDisconnectStatus) {
            return;
          }

          this.callbacks.onConnectionStatus?.({
            binding,
            status: "disconnected",
            agentUrl: target.url,
          });
          return;
        }

        this.callbacks.onConnectionStatus?.({
          binding,
          status: "error",
          agentUrl: target.url,
          error: err,
        });
        console.error(
          `[connection] binding ${binding.id} error:`,
          String(err),
        );
      });

    connection = {
      abortController,
      agentClient,
      agentUrl: target.url,
      binding,
      hasReportedConnected: false,
      promise,
      suppressDisconnectStatus: false,
    };

    return connection;
  }

  /** Replaces any existing binding connection, then starts a fresh one for the snapshot. */
  private async startConnection(binding: ChannelBinding): Promise<void> {
    const existing = this.connections.get(binding.id);
    if (existing) {
      console.log(
        `[connection] stopping existing connection for ${binding.id}`,
      );
      existing.suppressDisconnectStatus = true;
      existing.abortController.abort();
      await existing.promise.catch(() => {});
      this.connections.delete(binding.id);
    }

    const connection = await this.createConnection(binding);
    this.connections.set(binding.id, connection);
  }

  /** Resolves a live connection by channel/account, applying legacy Feishu defaults. */
  private getConnectionForChannelAccount(
    channelType: string | undefined,
    accountId: string | undefined,
  ): Connection {
    const normalizedChannelType = channelType ?? "feishu";
    const normalizedAccountId = accountId ?? "default";

    for (const connection of this.connections.values()) {
      if (
        connection.binding.enabled &&
        connection.binding.channelType === normalizedChannelType &&
        connection.binding.accountId === normalizedAccountId
      ) {
        return connection;
      }
    }

    throw new Error(
      `No active connection found for channelType=${channelType} accountId=${accountId}`,
    );
  }

  /** Extracts normalized routing and text fields from an OpenClaw channel context. */
  private buildMessageEvent(ctx: Record<string, unknown>): {
    accountId: string | undefined;
    channelType: string | undefined;
    sessionKey: string | undefined;
    userMessage: string;
  } {
    const userMessage =
      (ctx["BodyForAgent"] as string | undefined) ??
      (ctx["Body"] as string | undefined) ??
      (ctx["RawBody"] as string | undefined) ??
      "";

    const channelType =
      (ctx["ChannelType"] as string | undefined) ??
      (ctx["Channel"] as string | undefined) ??
      (ctx["Provider"] as string | undefined);
    const accountId = ctx["AccountId"] as string | undefined;
    const sessionKey = ctx["SessionKey"] as string | undefined;

    return { accountId, channelType, sessionKey, userMessage };
  }

  /** Sends inbound channel text to the bound agent and emits runtime message telemetry. */
  private async dispatchReply(
    event: ChannelReplyEvent,
  ): Promise<{ text: string } | null> {
    const { accountId, channelType, sessionKey, userMessage } =
      this.buildMessageEvent(event.ctx);

    if (!userMessage.trim()) {
      return null;
    }

    const connection = this.getConnectionForChannelAccount(
      channelType,
      accountId,
    );

    this.emitMessageInbound?.({
      accountId,
      agentUrl: connection.agentUrl,
      channelType,
      sessionKey,
      userMessage,
    });

    let result: { text: string } | null;
    try {
      result = await connection.agentClient.send({
        userMessage,
        contextId: sessionKey,
        accountId,
      });
    } catch (error) {
      this.callbacks.onAgentCallFailed?.({
        binding: connection.binding,
        agentUrl: connection.agentUrl,
        error,
      });
      throw error;
    }

    if (result) {
      this.emitMessageOutbound?.({
        accountId,
        agentUrl: connection.agentUrl,
        channelType,
        sessionKey,
        replyText: result.text,
      });
    }

    return result;
  }

  /** Handles OpenClaw reply events by delivering a final agent reply through the event shape. */
  async handleEvent(event: ChannelReplyEvent): Promise<ReplyDeliveryResult> {
    const response = await this.dispatchReply(event);
    return this.replyDelivery.deliver(event, response);
  }

  /** Starts or restarts a binding connection, stopping it instead when the binding is disabled. */
  async restartConnection(binding: ChannelBinding): Promise<void> {
    if (!binding.enabled) {
      await this.stopConnection(binding.id);
      return;
    }

    await this.startConnection(binding);
  }

  /** Reports whether a binding currently has a live connection record. */
  hasConnection(bindingId: string): boolean {
    return this.connections.has(bindingId);
  }

  /** Aborts one binding connection and waits for the host task to settle. */
  async stopConnection(bindingId: string): Promise<void> {
    const connection = this.connections.get(bindingId);
    if (!connection) return;

    console.log(`[connection] stopping binding: ${bindingId}`);
    connection.suppressDisconnectStatus = true;
    connection.abortController.abort();
    await connection.promise.catch(() => {});
    this.connections.delete(bindingId);
  }

  /** Stops every tracked binding connection serially for deterministic cleanup. */
  async stopAllConnections(): Promise<void> {
    for (const bindingId of Array.from(this.connections.keys())) {
      await this.stopConnection(bindingId);
    }
  }

  /** Returns the configured plugin host or fails when initialize() was not called. */
  private requireHost(): OpenClawPluginHost {
    if (!this.host) {
      throw new Error("ConnectionManager has not been initialized");
    }

    return this.host;
  }

  /** Returns the configured agent-client resolver or fails before connection work starts. */
  private requireAgentClientFactory(): NonNullable<
    ConnectionManager["getAgentClient"]
  > {
    if (!this.getAgentClient) {
      throw new Error("ConnectionManager has not been initialized");
    }

    return this.getAgentClient;
  }
}
