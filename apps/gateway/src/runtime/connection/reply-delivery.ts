import type { AgentFile, AgentResponseStreamEvent } from "@agent-relay/agent-transport";
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
    response: { text: string; files?: AgentFile[] } | null,
  ): Promise<ReplyDeliveryResult> {
    if (event.type === "channel.reply.dispatch") {
      return this.deliverDispatchEvent(event, response);
    }

    return this.deliverBufferedEvent(event, response);
  }

  /** Streams agent events into the channel-specific OpenClaw delivery surface. */
  async deliverStream(
    event: ChannelReplyEvent,
    stream: AsyncIterable<AgentResponseStreamEvent>,
  ): Promise<ReplyDeliveryResult> {
    if (event.type === "channel.reply.dispatch") {
      return this.deliverDispatchStream(event, stream);
    }

    return this.deliverBufferedStream(event, stream);
  }

  /** Completes dispatcher-based reply events after optionally sending final text. */
  private async deliverDispatchEvent(
    event: Extract<ChannelReplyEvent, { type: "channel.reply.dispatch" }>,
    response: { text: string; files?: AgentFile[] } | null,
  ): Promise<ReplyDeliveryResult> {
    if (!response) {
      event.dispatcher.markComplete();
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }

    const mediaUrls = resolveMediaUrls(response.files);
    event.dispatcher.sendFinalReply({
      text: response.text,
      ...(mediaUrls.length ? { mediaUrls } : {}),
    });
    event.dispatcher.markComplete();
    await event.dispatcher.waitForIdle();
    return {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    };
  }

  /** Delivers buffered reply events through their dispatcher options callback. */
  private async deliverBufferedEvent(
    event: Exclude<ChannelReplyEvent, { type: "channel.reply.dispatch" }>,
    response: { text: string; files?: AgentFile[] } | null,
  ): Promise<ReplyDeliveryResult> {
    if (!response) {
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }

    const mediaUrls = resolveMediaUrls(response.files);
    try {
      await event.dispatcherOptions.deliver(
        { text: response.text, ...(mediaUrls.length ? { mediaUrls } : {}) },
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

  private async deliverDispatchStream(
    event: Extract<ChannelReplyEvent, { type: "channel.reply.dispatch" }>,
    stream: AsyncIterable<AgentResponseStreamEvent>,
  ): Promise<ReplyDeliveryResult> {
    const counts = { tool: 0, block: 0, final: 0 };
    let lastText = "";
    let lastFiles: AgentFile[] | undefined;
    let sentFinal = false;

    try {
      for await (const chunk of stream) {
        const hasContent = chunk.text.trim() || chunk.files?.length;
        if (!hasContent) {
          continue;
        }

        if (chunk.text) lastText = chunk.text;
        if (chunk.files?.length) lastFiles = chunk.files;

        if (chunk.kind === "partial") {
          await event.replyOptions?.onPartialReply?.({ text: chunk.text });
          continue;
        }

        const mediaUrls = resolveMediaUrls(chunk.files);
        if (chunk.kind === "block") {
          event.dispatcher.sendBlockReply({
            text: chunk.text,
            ...(mediaUrls.length ? { mediaUrls } : {}),
          });
          counts.block += 1;
          continue;
        }

        event.dispatcher.sendFinalReply({
          text: chunk.text,
          ...(mediaUrls.length ? { mediaUrls } : {}),
        });
        counts.final += 1;
        sentFinal = true;
      }

      if (!sentFinal && (lastText || lastFiles?.length)) {
        const mediaUrls = resolveMediaUrls(lastFiles);
        event.dispatcher.sendFinalReply({
          text: lastText,
          ...(mediaUrls.length ? { mediaUrls } : {}),
        });
        counts.final += 1;
      }

      event.dispatcher.markComplete();
      await event.dispatcher.waitForIdle();
      return { queuedFinal: false, counts };
    } catch (error) {
      event.dispatcher.markComplete();
      throw error;
    }
  }

  private async deliverBufferedStream(
    event: Exclude<ChannelReplyEvent, { type: "channel.reply.dispatch" }>,
    stream: AsyncIterable<AgentResponseStreamEvent>,
  ): Promise<ReplyDeliveryResult> {
    const counts = { tool: 0, block: 0, final: 0 };
    let lastText = "";
    let lastFiles: AgentFile[] | undefined;
    let sentFinal = false;

    for await (const chunk of stream) {
      const hasContent = chunk.text.trim() || chunk.files?.length;
      if (!hasContent) {
        continue;
      }

      if (chunk.text) lastText = chunk.text;
      if (chunk.files?.length) lastFiles = chunk.files;

      if (chunk.kind === "partial") {
        await event.replyOptions?.onPartialReply?.({ text: chunk.text });
        continue;
      }

      const kind = chunk.kind === "block" ? "block" : "final";
      const mediaUrls = resolveMediaUrls(chunk.files);
      try {
        await event.dispatcherOptions.deliver(
          { text: chunk.text, ...(mediaUrls.length ? { mediaUrls } : {}) },
          { kind },
        );
        counts[kind] += 1;
        if (kind === "final") {
          sentFinal = true;
        }
      } catch (error) {
        event.dispatcherOptions.onError?.(error, { kind });
      }
    }

    if (!sentFinal && (lastText || lastFiles?.length)) {
      const mediaUrls = resolveMediaUrls(lastFiles);
      try {
        await event.dispatcherOptions.deliver(
          { text: lastText, ...(mediaUrls.length ? { mediaUrls } : {}) },
          { kind: "final" },
        );
        counts.final += 1;
      } catch (error) {
        event.dispatcherOptions.onError?.(error, { kind: "final" });
      }
    }

    return { queuedFinal: false, counts };
  }
}

/** Resolve media URLs from agent file attachments for outbound channel delivery. */
function resolveMediaUrls(files: AgentFile[] | undefined): string[] {
  if (!files?.length) return [];
  return files.map((f) => f.url).filter((u): u is string => Boolean(u));
}
