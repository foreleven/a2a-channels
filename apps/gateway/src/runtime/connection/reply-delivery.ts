import type { ChannelReplyEvent } from "@agent-relay/openclaw-compat";

export type ReplyDeliveryResult = {
  counts: { block: number; final: number; tool: number };
  queuedFinal: boolean;
};

/** Adapts agent reply text to the two OpenClaw reply event delivery shapes. */
export class ChannelReplyDelivery {
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
