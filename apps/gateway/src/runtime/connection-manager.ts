/**
 * ConnectionManager – lifecycle and dispatch manager for channel bindings.
 *
 * Owns per-binding Connection instances and starts/stops them through the
 * plugin host. Each Connection handles the chat message path for its binding.
 */

import type { AgentClient } from "@a2a-channels/agent-transport";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";
import type {
  ChannelBindingStatusUpdate,
  ChannelReplyEvent,
  MessageInboundEvent,
  MessageOutboundEvent,
} from "@a2a-channels/openclaw-compat";
import { inject, injectable } from "inversify";
import type { ConnectionStatus } from "./runtime-connection-status.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";

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

type ReplyDeliveryResult = {
  counts: { block: number; final: number; tool: number };
  queuedFinal: boolean;
};

export interface ConnectionOptions {
  agentClient: AgentClient;
  binding: ChannelBinding;
  runtime: OpenClawPluginRuntime;
  callbacks?: ConnectionCallbacks;
}

/** Live plugin and agent connection for one owned channel binding. */
export class Connection {
  readonly abortController = new AbortController();
  hasReportedConnected = false;
  promise: Promise<void> = Promise.resolve();
  suppressDisconnectStatus = false;
  private readonly replyDelivery = new ChannelReplyDelivery();
  private readonly handleRuntimeMessage = (
    event: MessageInboundEvent,
  ): Promise<ReplyDeliveryResult | undefined> => this.handleInbound(event);
  private listening = false;

  constructor(private readonly options: ConnectionOptions) {}

  get agentUrl(): string {
    return this.options.agentClient.agentUrl;
  }

  get binding(): ChannelBinding {
    return this.options.binding;
  }

  start(host: OpenClawPluginHost): void {
    console.log(
      `[connection] starting binding ${this.binding.id} for ${this.binding.channelType}:${this.binding.accountId}`,
      this.binding,
    );

    this.options.callbacks?.onConnectionStatus?.({
      binding: this.binding,
      status: "connecting",
      agentUrl: this.agentUrl,
    });
    this.listen();

    this.promise = Promise.resolve()
      .then(() =>
        host.startChannelBinding(this.binding, this.abortController.signal, {
          onStatus: (status) => this.maybeReportConnected(status),
        }),
      )
      .then(() => {
        if (this.suppressDisconnectStatus) {
          return;
        }

        this.options.callbacks?.onConnectionStatus?.({
          binding: this.binding,
          status: "disconnected",
          agentUrl: this.agentUrl,
        });
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") {
          if (this.suppressDisconnectStatus) {
            return;
          }

          this.options.callbacks?.onConnectionStatus?.({
            binding: this.binding,
            status: "disconnected",
            agentUrl: this.agentUrl,
          });
          return;
        }

        this.options.callbacks?.onConnectionStatus?.({
          binding: this.binding,
          status: "error",
          agentUrl: this.agentUrl,
          error: err,
        });
        console.error(
          `[connection] binding ${this.binding.id} error:`,
          String(err),
        );
      });
  }

  async stop(): Promise<void> {
    this.suppressDisconnectStatus = true;
    this.unlisten();
    this.abortController.abort();
    await this.promise.catch(() => {});
  }

  listen(): void {
    if (this.listening) {
      return;
    }

    this.listening = true;
    this.options.runtime.on("message:inbound", this.handleRuntimeMessage);
  }

  unlisten(): void {
    if (!this.listening) {
      return;
    }

    this.listening = false;
    this.options.runtime.off("message:inbound", this.handleRuntimeMessage);
  }

  matchesChannelAccount(
    channelType: string | undefined,
    accountId: string | undefined,
  ): boolean {
    return (
      this.binding.enabled &&
      this.binding.channelType === (channelType ?? "feishu") &&
      this.binding.accountId === (accountId ?? "default")
    );
  }

  /** Handles a full inbound runtime message for this connection when it owns the binding. */
  async handleInbound(
    event: MessageInboundEvent,
  ): Promise<ReplyDeliveryResult | undefined> {
    if (!this.matchesChannelAccount(event.channelType, event.accountId)) {
      return undefined;
    }

    const response = await this.handleMessage(event);
    return this.replyDelivery.deliver(event.replyEvent, response);
  }

  /** Sends inbound channel text to the bound agent and emits outbound telemetry. */
  async handleMessage(
    event: MessageInboundEvent,
  ): Promise<{ text: string } | null> {
    const { accountId, channelType, sessionKey, userMessage } = event;

    if (!userMessage.trim()) {
      return null;
    }

    let result: { text: string } | null;
    try {
      result = await this.options.agentClient.send({
        userMessage,
        contextId: sessionKey,
        accountId,
      });
    } catch (error) {
      this.options.callbacks?.onAgentCallFailed?.({
        binding: this.binding,
        agentUrl: this.agentUrl,
        error,
      });
      result = { text: "(agent temporarily unavailable)" };
    }

    if (result) {
      this.options.callbacks?.emitMessageOutbound?.({
        accountId,
        agentUrl: this.agentUrl,
        channelType,
        sessionKey,
        replyText: result.text,
      });
    }

    return result;
  }

  private maybeReportConnected(status: ChannelBindingStatusUpdate): void {
    if (this.hasReportedConnected) {
      return;
    }

    if (status.connected !== true && status.running !== true) {
      return;
    }

    this.hasReportedConnected = true;
    this.options.callbacks?.onConnectionStatus?.({
      binding: this.binding,
      status: "connected",
      agentUrl: this.agentUrl,
    });
  }
}

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

/** Orchestrates channel plugin connection lifecycle and routes reply events. */
@injectable()
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();

  constructor(
    @inject(OpenClawPluginHost)
    private readonly host: OpenClawPluginHost,
    @inject(OpenClawPluginRuntime)
    private readonly runtime: OpenClawPluginRuntime,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
  ) {}

  /** Creates a plugin-host connection and reports status transitions from the host. */
  private async createConnection(binding: ChannelBinding): Promise<Connection> {
    const target = await this.agentRegistry.getAgentClient(binding.agentId);
    const connection = new Connection({
      agentClient: target.client,
      binding,
      runtime: this.runtime,
      callbacks: {
        emitMessageOutbound: (event) =>
          this.runtime.emit("message:outbound", event),
        onAgentCallFailed: (event) => this.logAgentCallFailed(event),
        onConnectionStatus: (event) => this.emitConnectionStatus(event),
      },
    });
    connection.start(this.host);

    return connection;
  }

  /** Replaces any existing binding connection, then starts a fresh one for the snapshot. */
  private async startConnection(binding: ChannelBinding): Promise<void> {
    const existing = this.connections.get(binding.id);
    if (existing) {
      console.log(
        `[connection] stopping existing connection for ${binding.id}`,
      );
      await existing.stop();
      this.connections.delete(binding.id);
    }

    const connection = await this.createConnection(binding);
    this.connections.set(binding.id, connection);
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
    await connection.stop();
    this.connections.delete(bindingId);
  }

  /** Stops every tracked binding connection serially for deterministic cleanup. */
  async stopAllConnections(): Promise<void> {
    for (const bindingId of Array.from(this.connections.keys())) {
      await this.stopConnection(bindingId);
    }
  }

  onConnectionStatus(
    listener: (event: ConnectionLifecycleEvent) => void,
  ): void {
    this.connectionStatusListeners.add(listener);
  }

  private readonly connectionStatusListeners = new Set<
    (event: ConnectionLifecycleEvent) => void
  >();

  private emitConnectionStatus(event: ConnectionLifecycleEvent): void {
    for (const listener of this.connectionStatusListeners) {
      listener(event);
    }
  }

  private logAgentCallFailed({ binding, error }: AgentCallFailureEvent): void {
    console.error(
      `[runtime] agent call failed for binding ${binding.id}:`,
      String(error),
    );
  }
}
