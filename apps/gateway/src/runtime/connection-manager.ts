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

export interface Connection {
  abortController: AbortController;
  agentClient: AgentClientHandle;
  agentUrl: string;
  binding: ChannelBinding;
  hasReportedConnected: boolean;
  promise: Promise<void>;
  suppressDisconnectStatus: boolean;
}

export interface ConnectionLifecycleEvent {
  binding: ChannelBinding;
  status: ConnectionStatus;
  agentUrl?: string;
  error?: unknown;
}

export interface AgentCallFailureEvent {
  binding: ChannelBinding;
  agentUrl: string;
  error: unknown;
}

export interface ConnectionManagerCallbacks {
  onConnectionStatus?: (event: ConnectionLifecycleEvent) => void;
  onAgentCallFailed?: (event: AgentCallFailureEvent) => void;
}

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

/** Orchestrates channel plugin connections and forwards inbound messages to agents. */
@injectable()
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private host: OpenClawPluginHost | null = null;
  private getAgentClient:
    | ConnectionManagerOptions["getAgentClient"]
    | null = null;
  private emitMessageInbound?: (event: MessageInboundEvent) => void;
  private emitMessageOutbound?: (event: MessageOutboundEvent) => void;
  private callbacks: ConnectionManagerCallbacks = {};

  initialize(options: ConnectionManagerOptions): this {
    this.host = options.host;
    this.getAgentClient = options.getAgentClient;
    this.emitMessageInbound = options.emitMessageInbound;
    this.emitMessageOutbound = options.emitMessageOutbound;
    this.callbacks = options.callbacks ?? {};
    return this;
  }

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

  async handleEvent(event: ChannelReplyEvent): Promise<{
    counts: { block: number; final: number; tool: number };
    queuedFinal: boolean;
  }> {
    const response = await this.dispatchReply(event);

    if (event.type === "channel.reply.dispatch") {
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

  async restartConnection(binding: ChannelBinding): Promise<void> {
    if (!binding.enabled) {
      await this.stopConnection(binding.id);
      return;
    }

    await this.startConnection(binding);
  }

  hasConnection(bindingId: string): boolean {
    return this.connections.has(bindingId);
  }

  async stopConnection(bindingId: string): Promise<void> {
    const connection = this.connections.get(bindingId);
    if (!connection) return;

    console.log(`[connection] stopping binding: ${bindingId}`);
    connection.suppressDisconnectStatus = true;
    connection.abortController.abort();
    await connection.promise.catch(() => {});
    this.connections.delete(bindingId);
  }

  async stopAllConnections(): Promise<void> {
    for (const bindingId of Array.from(this.connections.keys())) {
      await this.stopConnection(bindingId);
    }
  }

  private requireHost(): OpenClawPluginHost {
    if (!this.host) {
      throw new Error("ConnectionManager has not been initialized");
    }

    return this.host;
  }

  private requireAgentClientFactory(): NonNullable<
    ConnectionManager["getAgentClient"]
  > {
    if (!this.getAgentClient) {
      throw new Error("ConnectionManager has not been initialized");
    }

    return this.getAgentClient;
  }
}
