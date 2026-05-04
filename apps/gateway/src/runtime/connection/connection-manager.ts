/**
 * ConnectionManager - lifecycle and dispatch manager for channel bindings.
 *
 * Owns per-binding Connection instances and starts/stops them through the
 * plugin host. Each Connection handles the chat message path for its binding.
 */

import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import {
  type ChannelReplyDispatchResult,
  type ChannelReplyEvent,
  type MessageInboundEvent,
  type MessageOutboundEvent,
  OpenClawPluginHost,
  OpenClawPluginRuntime,
  type ReplyEventDispatcher,
} from "@a2a-channels/openclaw-compat";
import { inject, injectable } from "inversify";

import { channelTypeRegistry } from "../channel-type-registry.js";
import { RuntimeAgentRegistry } from "../runtime-agent-registry.js";
import { Connection } from "./connection.js";
import type {
  AgentCallFailureEvent,
  ConnectionLifecycleEvent,
} from "./events.js";

type ChannelBinding = ChannelBindingSnapshot;

/** Orchestrates channel plugin connection lifecycle and routes reply events. */
@injectable()
export class ConnectionManager implements ReplyEventDispatcher {
  private readonly connections = new Map<string, Connection>();
  private readonly connectionsByChannelAccount = new Map<string, Connection>();

  constructor(
    @inject(OpenClawPluginHost)
    private readonly host: OpenClawPluginHost,
    @inject(OpenClawPluginRuntime)
    private readonly runtime: OpenClawPluginRuntime,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
  ) {
    this.runtime.setReplyEventDispatcher(this);
  }

  /** Routes one OpenClaw reply event to the owned connection for its channel account. */
  async dispatchReplyEvent(
    event: ChannelReplyEvent,
  ): Promise<ChannelReplyDispatchResult> {
    const message = this.buildMessageInboundEvent(event);
    const connection = this.connectionsByChannelAccount.get(
      this.connectionLookupKey(message.channelType, message.accountId),
    );
    if (connection) {
      const result = await connection.handleInbound(message);
      if (result) {
        return result;
      }
    }

    return this.completeUnhandledReplyEvent(message);
  }

  /** Creates a plugin-host connection and reports status transitions from the host. */
  private async createConnection(binding: ChannelBinding): Promise<Connection> {
    const target = await this.agentRegistry.getAgentClient(binding.agentId);
    const connection = new Connection({
      agentClient: target.client,
      binding,
      callbacks: {
        emitMessageOutbound: (event) => this.emitMessageOutbound(event),
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
      this.untrackConnection(existing);
    }

    const connection = await this.createConnection(binding);
    this.trackConnection(connection);
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
    this.untrackConnection(connection);
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

  private emitMessageOutbound(_event: MessageOutboundEvent): void {
    // Reserved for runtime telemetry sinks. No production listener currently
    // consumes outbound message events.
  }

  private async completeUnhandledReplyEvent(
    message: MessageInboundEvent,
  ): Promise<ChannelReplyDispatchResult> {
    console.warn(
      `[runtime] no active connection for channelType=${message.channelType} accountId=${message.accountId}; message dropped`,
    );

    if (message.replyEvent.type === "channel.reply.dispatch") {
      message.replyEvent.dispatcher.markComplete();
      try {
        await message.replyEvent.dispatcher.waitForIdle();
      } catch {
        // Ignore draining errors when no connection handled the message.
      }
    }

    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }

  private buildMessageInboundEvent(event: ChannelReplyEvent): MessageInboundEvent {
    const ctx = event.ctx as Record<string, unknown>;
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

    return {
      accountId,
      channelType,
      replyEvent: event,
      sessionKey,
      userMessage,
    };
  }

  private trackConnection(connection: Connection): void {
    this.connections.set(connection.binding.id, connection);
    this.connectionsByChannelAccount.set(
      this.connectionLookupKey(
        connection.binding.channelType,
        connection.binding.accountId,
      ),
      connection,
    );
  }

  private untrackConnection(connection: Connection): void {
    this.connections.delete(connection.binding.id);
    const lookupKey = this.connectionLookupKey(
      connection.binding.channelType,
      connection.binding.accountId,
    );
    if (this.connectionsByChannelAccount.get(lookupKey) === connection) {
      this.connectionsByChannelAccount.delete(lookupKey);
    }
  }

  private connectionLookupKey(
    channelType: string | undefined,
    accountId: string | undefined,
  ): string {
    const canonicalChannelType = channelTypeRegistry.canonicalize(
      channelType ?? "feishu",
    );

    return `${canonicalChannelType}:${accountId ?? "default"}`;
  }
}
