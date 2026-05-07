/**
 * ConnectionManager - lifecycle and dispatch manager for channel bindings.
 *
 * Owns per-binding Connection instances and starts/stops them through the
 * plugin host. Each Connection handles the chat message path for its binding.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  ChannelMessageRepository,
  SessionKey,
  type ChannelBindingSnapshot,
  type ChannelMessageRepository as ChannelMessageRepositoryPort,
} from "@agent-relay/domain";
import {
  type ChannelReplyDispatchResult,
  type ChannelReplyEvent,
  OpenClawPluginHost,
  OpenClawPluginRuntime,
  type ReplyEventDispatcher,
} from "@agent-relay/openclaw-compat";
import type { AgentFile } from "@agent-relay/agent-transport";
import { inject, injectable } from "inversify";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../../infra/logger.js";
import { channelTypeRegistry } from "../channel-type-registry.js";
import { RuntimeAgentRegistry } from "../runtime-agent-registry.js";
import { Connection } from "./connection.js";
import type {
  AgentCallFailureEvent,
  ConnectionLifecycleEvent,
  GatewayMessageInboundEvent,
  GatewayMessageOutboundEvent,
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
    @inject(ChannelMessageRepository)
    private readonly messageRepository: ChannelMessageRepositoryPort,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
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
    const agentClient = await this.agentRegistry.getAgentClient(
      binding.agentId,
    );
    const connection = new Connection({
      agentClient,
      binding,
      logger: this.logger.child(this.bindingLogFields(binding)),
      callbacks: {
        emitMessageInbound: (event) => this.emitMessageInbound(binding, event),
        emitMessageOutbound: (event) =>
          this.emitMessageOutbound(binding, event),
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
      this.logger.info(
        this.bindingLogFields(binding),
        "stopping existing connection before restart",
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

    this.logger.info(
      this.bindingLogFields(connection.binding),
      "stopping channel binding connection",
    );
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
    this.logger.error(
      { ...this.bindingLogFields(binding), err: error },
      "agent call failed for channel binding",
    );
  }

  private emitMessageInbound(
    binding: ChannelBinding,
    event: GatewayMessageInboundEvent,
  ): void {
    void this.messageRepository
      .append({
        channelBindingId: binding.id,
        direction: "input",
        channelType: binding.channelType,
        accountId: event.accountId,
        sessionKey: event.sessionKey,
        content: event.userMessage,
        metadata: {
          channelType: event.channelType,
          ...(event.replyToId ? { replyToId: event.replyToId } : {}),
          ...(event.files?.length ? { files: event.files } : {}),
        },
      })
      .catch((error) => this.logMessagePersistenceFailed(binding, error));
  }

  private emitMessageOutbound(
    binding: ChannelBinding,
    event: GatewayMessageOutboundEvent,
  ): void {
    void this.messageRepository
      .append({
        channelBindingId: binding.id,
        direction: "output",
        channelType: binding.channelType,
        accountId: event.accountId,
        sessionKey: event.sessionKey,
        content: event.replyText,
        metadata: {
          channelType: event.channelType,
          ...(event.metadata ?? {}),
        },
      })
      .catch((error) => this.logMessagePersistenceFailed(binding, error));
  }

  private logMessagePersistenceFailed(
    binding: ChannelBinding,
    error: unknown,
  ): void {
    this.logger.error(
      { ...this.bindingLogFields(binding), err: error },
      "message persistence failed for channel binding",
    );
  }

  private async completeUnhandledReplyEvent(
    message: GatewayMessageInboundEvent,
  ): Promise<ChannelReplyDispatchResult> {
    this.logger.warn(
      {
        channelType: message.channelType,
        accountId: message.accountId,
        sessionKey: message.sessionKey.toString(),
      },
      "no active connection for inbound channel message; message dropped",
    );

    if (message.event.type === "channel.reply.dispatch") {
      message.event.dispatcher.markComplete();
      try {
        await message.event.dispatcher.waitForIdle();
      } catch {
        // Ignore draining errors when no connection handled the message.
      }
    }

    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }

  private buildMessageInboundEvent(
    event: ChannelReplyEvent,
  ): GatewayMessageInboundEvent {
    const ctx = event.ctx;
    const userMessage =
      readNonEmptyString(ctx.BodyForAgent) ??
      readNonEmptyString(ctx.Body) ??
      readNonEmptyString(ctx.RawBody) ??
      "";
    const channelType = normalizeChannelType(ctx);
    const accountId = normalizeAccountId(ctx.AccountId);
    // Prefer OpenClaw route sessions, then synthesize a compact fallback key.
    const sessionKey = SessionKey.fromString(
      normalizeSessionKey(ctx.SessionKey) ??
        buildFallbackSessionKey({
          accountId,
          channelType,
          ctx,
        }),
    );
    const files = buildFilesFromContext(ctx);

    this.logger.info(ctx, "Inbound message event");

    return {
      accountId,
      channelType,
      event,
      sessionKey,
      userMessage,
      replyToId: ctx.ReplyToId,
      ...(files.length ? { files } : {}),
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
    accountId: string,
  ): string {
    const canonicalChannelType = channelTypeRegistry.canonicalize(
      channelType ?? "feishu",
    );

    return `${canonicalChannelType}:${accountId}`;
  }

  private bindingLogFields(binding: ChannelBinding): Record<string, unknown> {
    return {
      bindingId: binding.id,
      channelType: binding.channelType,
      accountId: binding.accountId,
      agentId: binding.agentId,
    };
  }
}

function normalizeAccountId(accountId: unknown): string {
  return typeof accountId === "string" && accountId.trim()
    ? accountId
    : "default";
}

function normalizeSessionKey(sessionKey: unknown): string | undefined {
  return typeof sessionKey === "string" && sessionKey.trim()
    ? sessionKey.trim()
    : undefined;
}

function normalizeChannelType(ctx: ChannelReplyEvent["ctx"]): string {
  return normalizeLowercaseStringOrEmpty(
    readNonEmptyString(ctx.Surface) ??
      readNonEmptyString(ctx.Provider) ??
      "unknown",
  );
}

function buildFallbackSessionKey({
  accountId,
  channelType,
  ctx,
}: {
  accountId: string;
  channelType: string | undefined;
  ctx: ChannelReplyEvent["ctx"];
}): string {
  const peer =
    readNonEmptyString(ctx.OriginatingTo) ??
    readNonEmptyString(ctx.To) ??
    readNonEmptyString(ctx.From);
  const discriminator =
    peer ??
    readNonEmptyString(ctx.MessageSid) ??
    readNonEmptyString(ctx.RawBody) ??
    randomUUID();
  const hash = createHash("md5")
    .update(
      JSON.stringify({
        accountId,
        channelType: channelType ?? "unknown",
        discriminator,
      }),
    )
    .digest("hex");

  return `fallback:${hash}`;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Extract file attachments from an inbound channel context.
 *
 * Channel plugins populate MediaUrls/MediaUrl (and corresponding MediaTypes)
 * when the inbound message contains image or other media attachments.
 */
function buildFilesFromContext(ctx: ChannelReplyEvent["ctx"]): AgentFile[] {
  const urls =
    readStringArray(ctx.MediaUrls) ??
    (ctx.MediaUrl && typeof ctx.MediaUrl === "string" ? [ctx.MediaUrl] : []);

  if (!urls.length) return [];

  const types = readStringArray(ctx.MediaTypes);

  return urls
    .map((url, i): AgentFile | null => {
      const mimeType =
        types?.[i] ??
        (typeof ctx.MediaType === "string" && i === 0
          ? ctx.MediaType
          : undefined);
      const trimmed = url.trim();
      if (!trimmed) return null;
      return {
        url: trimmed,
        ...(mimeType ? { mimeType } : {}),
      };
    })
    .filter((f): f is AgentFile => f !== null);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length ? strings : undefined;
}
