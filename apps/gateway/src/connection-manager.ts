/**
 * ConnectionManager – lifecycle and dispatch manager for channel bindings.
 *
 * Owns per-binding connections (binding + agent client + AbortController +
 * running Promise), starts/stops them through the plugin host, and handles
 * channel reply dispatch events by routing inbound messages through the bound
 * agent client and returning replies to the channel dispatcher.
 */

import type { AgentClientHandle, ChannelBinding } from "@a2a-channels/core";
import type {
  ChannelReplyEvent,
  MessageInboundEvent,
  MessageOutboundEvent,
  OpenClawPluginHost,
} from "@a2a-channels/openclaw-compat";

export interface Connection {
  abortController: AbortController;
  agentClient: AgentClientHandle;
  binding: ChannelBinding;
  promise: Promise<void>;
}

export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly host: OpenClawPluginHost,
    private readonly listBindings: () =>
      | ChannelBinding[]
      | Promise<ChannelBinding[]>,
    private readonly getAgentClient: (
      agentUrl: string,
    ) => AgentClientHandle | Promise<AgentClientHandle>,
    private readonly emitMessageInbound?: (event: MessageInboundEvent) => void,
    private readonly emitMessageOutbound?: (
      event: MessageOutboundEvent,
    ) => void,
  ) {}

  private async createConnection(binding: ChannelBinding): Promise<Connection> {
    const abortController = new AbortController();
    const agentClient = await this.getAgentClient(binding.agentUrl);

    console.log(
      `[connection] starting binding ${binding.id} for ${binding.channelType}:${binding.accountId}`,
      binding,
    );

    const promise = this.host
      .startChannelBinding(binding, abortController.signal)
      .then(() => {
        console.log(`[connection] binding ${binding.id} connected`);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== "AbortError") {
          console.error(
            `[connection] binding ${binding.id} error:`,
            String(err),
          );
        }
      });

    return { abortController, agentClient, binding, promise };
  }

  private async startConnection(binding: ChannelBinding): Promise<void> {
    const existing = this.connections.get(binding.id);
    if (existing) {
      console.log(
        `[connection] stopping existing connection for ${binding.id}`,
      );
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
      agentUrl: connection.binding.agentUrl,
      channelType,
      sessionKey,
      userMessage,
    });

    const result = await connection.agentClient.send({
      userMessage,
      contextId: sessionKey,
      accountId,
    });

    if (result) {
      this.emitMessageOutbound?.({
        accountId,
        agentUrl: connection.binding.agentUrl,
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

  async syncConnections(): Promise<void> {
    const bindings = (await this.listBindings()).filter(
      (binding) => binding.enabled,
    );
    console.log(
      `[connection] syncConnections: ${bindings.length} enabled binding(s)`,
    );
    const activeIds = new Set(bindings.map((binding) => binding.id));

    for (const [bindingId, connection] of this.connections.entries()) {
      if (!activeIds.has(bindingId)) {
        console.log(`[connection] stopping removed binding: ${bindingId}`);
        connection.abortController.abort();
        await connection.promise.catch(() => {});
        this.connections.delete(bindingId);
      }
    }

    for (const binding of bindings) {
      if (!this.connections.has(binding.id)) {
        await this.startConnection(binding);
      }
    }
  }

  async restartConnection(binding: ChannelBinding): Promise<void> {
    if (!binding.enabled) {
      await this.stopConnection(binding.id);
      return;
    }

    await this.startConnection(binding);
  }

  async stopConnection(bindingId: string): Promise<void> {
    const connection = this.connections.get(bindingId);
    if (!connection) return;

    console.log(`[connection] stopping binding: ${bindingId}`);
    connection.abortController.abort();
    await connection.promise.catch(() => {});
    this.connections.delete(bindingId);
  }

  async stopAllConnections(): Promise<void> {
    for (const bindingId of Array.from(this.connections.keys())) {
      await this.stopConnection(bindingId);
    }
  }
}
