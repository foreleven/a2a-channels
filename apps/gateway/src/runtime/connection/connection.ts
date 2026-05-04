import type { AgentClient } from "@a2a-channels/agent-transport";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";
import type {
  ChannelBindingStatusUpdate,
  MessageInboundEvent,
} from "@a2a-channels/openclaw-compat";

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

  get agentTarget(): string {
    return this.options.agentClient.displayTarget;
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
      agentUrl: this.agentTarget,
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
          agentUrl: this.agentTarget,
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
            agentUrl: this.agentTarget,
          });
          return;
        }

        this.options.callbacks?.onConnectionStatus?.({
          binding: this.binding,
          status: "error",
          agentUrl: this.agentTarget,
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
    accountId: string | undefined,
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
        agentUrl: this.agentTarget,
        error,
      });
      result = { text: "(agent temporarily unavailable)" };
    }

    if (result) {
      this.options.callbacks?.emitMessageOutbound?.({
        accountId,
        agentUrl: this.agentTarget,
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
      agentUrl: this.agentTarget,
    });
  }
}
