import type {
  AgentClient,
  AgentResponseStreamEvent,
} from "@agent-relay/agent-transport";
import type { ChannelBindingSnapshot } from "@agent-relay/domain";
import { OpenClawPluginHost } from "@agent-relay/openclaw-compat";
import type {
  ChannelBindingStatusUpdate,
  MessageInboundEvent,
} from "@agent-relay/openclaw-compat";

import { channelTypeRegistry } from "../channel-type-registry.js";
import type { ConnectionCallbacks } from "./events.js";
import {
  ChannelReplyDelivery,
  type ReplyDeliveryResult,
} from "./reply-delivery.js";

type ChannelBinding = ChannelBindingSnapshot;

export interface ConnectionOptions {
  agentClient: AgentClient;
  binding: ChannelBinding;
  callbacks?: ConnectionCallbacks;
}

/** Live plugin and agent connection for one owned channel binding. */
export class Connection {
  readonly abortController = new AbortController();
  hasReportedConnected = false;
  promise: Promise<void> = Promise.resolve();
  suppressDisconnectStatus = false;
  private readonly replyDelivery = new ChannelReplyDelivery();

  constructor(private readonly options: ConnectionOptions) {}

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
    });

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
          });
          return;
        }

        this.options.callbacks?.onConnectionStatus?.({
          binding: this.binding,
          status: "error",
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
    this.abortController.abort();
    await this.promise.catch(() => {});
  }

  matchesChannelAccount(
    channelType: string | undefined,
    accountId: string,
  ): boolean {
    const bindingChannelType = channelTypeRegistry.canonicalize(
      this.binding.channelType,
    );
    const incomingChannelType = channelTypeRegistry.canonicalize(
      channelType ?? "feishu",
    );

    return (
      this.binding.enabled &&
      bindingChannelType === incomingChannelType &&
      this.binding.accountId === accountId
    );
  }

  /** Handles a full inbound runtime message for this connection when it owns the binding. */
  async handleInbound(
    event: MessageInboundEvent,
  ): Promise<ReplyDeliveryResult | undefined> {
    if (!this.matchesChannelAccount(event.channelType, event.accountId)) {
      return undefined;
    }

    if (!event.userMessage.trim() && !event.files?.length) {
      return this.replyDelivery.deliver(event.event, null);
    }

    return this.replyDelivery.deliverStream(
      event.event,
      this.handleMessageStream(event),
    );
  }

  /** Sends inbound channel text to the bound agent and emits outbound telemetry. */
  async handleMessage(
    event: MessageInboundEvent,
  ): Promise<{ text: string; files?: import("@agent-relay/agent-transport").AgentFile[] } | null> {
    const { accountId, channelType, sessionKey, userMessage, files } = event;

    if (!userMessage.trim() && !files?.length) {
      return null;
    }

    let result: { text: string; files?: import("@agent-relay/agent-transport").AgentFile[] } | null;
    try {
      result = await this.options.agentClient.send({
        userMessage,
        sessionKey,
        accountId,
        ...(files?.length ? { files } : {}),
      });
    } catch (error) {
      this.options.callbacks?.onAgentCallFailed?.({
        binding: this.binding,
        error,
      });
      result = { text: "(agent temporarily unavailable)" };
    }

    if (result) {
      this.options.callbacks?.emitMessageOutbound?.({
        accountId,
        channelType,
        sessionKey,
        replyText: result.text,
      });
    }

    return result;
  }

  /** Streams inbound channel text to the bound agent and emits final outbound telemetry. */
  async *handleMessageStream(
    event: MessageInboundEvent,
  ): AsyncIterable<AgentResponseStreamEvent> {
    const { accountId, channelType, sessionKey, userMessage, files } = event;
    let sawFinal = false;
    let lastText = "";

    try {
      for await (const chunk of this.options.agentClient.stream({
        userMessage,
        sessionKey,
        accountId,
        ...(files?.length ? { files } : {}),
      })) {
        if (chunk.text) {
          lastText = chunk.text;
        }
        if (chunk.kind === "final") {
          sawFinal = true;
          this.options.callbacks?.emitMessageOutbound?.({
            accountId,
            channelType,
            sessionKey,
            replyText: chunk.text,
          });
        }
        yield chunk;
      }

      if (!sawFinal && lastText) {
        this.options.callbacks?.emitMessageOutbound?.({
          accountId,
          channelType,
          sessionKey,
          replyText: lastText,
        });
      }
    } catch (error) {
      this.options.callbacks?.onAgentCallFailed?.({
        binding: this.binding,
        error,
      });
      yield { kind: "final", text: "(agent temporarily unavailable)" };
    }
  }

  private maybeReportConnected(status: ChannelBindingStatusUpdate): void {
    if (this.hasReportedConnected) {
      return;
    }

    if (status.connected === false || status.running === false) {
      return;
    }

    if (
      status.connected !== true &&
      status.running !== true &&
      status.accountId !== this.binding.accountId
    ) {
      return;
    }

    this.hasReportedConnected = true;
    this.options.callbacks?.onConnectionStatus?.({
      binding: this.binding,
      status: "connected",
    });
  }
}
